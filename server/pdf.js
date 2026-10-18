import { createHash } from "node:crypto";
import { PDFArray, PDFDocument, PDFName, PDFNull, PDFNumber, PDFSignature, PDFString } from "pdf-lib";
import placeholder from "@signpdf/placeholder-pdf-lib";
import signUtils from "@signpdf/utils";
import { createSignatureAppearance, validateVisibleSignature } from "./signature-appearance.js";

const { pdflibAddPlaceholder } = placeholder;
const { findByteRange } = signUtils;
export const SIGNATURE_BYTES = 16384;

function findSignatureBox(pdf, fields) {
  for (const page of pdf.getPages()) {
    const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annotations) continue;
    const crop = page.getCropBox();
    for (const field of fields) {
      if (field.isReadOnly()) continue;
      const widgets = field.acroField.getWidgets();
      if (widgets.length !== 1) continue;
      const widget = widgets[0];
      if (!annotations.asArray().some(ref => pdf.context.lookup(ref) === widget.dict)) continue;
      const flags = widget.dict.lookup(PDFName.of("F"))?.asNumber?.() ?? 0;
      if (flags & (1 | 2 | 32)) continue;
      const { x, y, width, height } = widget.getRectangle();
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
      const rotated = page.getRotation().angle % 180 !== 0;
      const viewWidth = rotated ? height : width;
      const viewHeight = rotated ? width : height;
      if (viewWidth < 120 || viewHeight < 36 || x < crop.x || y < crop.y ||
          x + width > crop.x + crop.width || y + height > crop.y + crop.height) continue;
      return { field, widget, page, rect: [x, y, x + width, y + height] };
    }
  }
  return undefined;
}

export async function preparePdf(input, { visibleSignature } = {}) {
  const visible = validateVisibleSignature(visibleSignature);
  if (!input.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    throw new Error("El archivo no es un PDF.");
  }
  const pdf = await PDFDocument.load(input, { updateMetadata: false });
  if (!pdf.getPageCount()) throw new Error("El PDF no contiene paginas.");
  const form = pdf.getForm();
  const formFields = form.getFields();
  const signatureFields = formFields.filter(field => field instanceof PDFSignature);
  for (const field of signatureFields) {
    const value = pdf.context.lookup(field.acroField.getInheritableAttribute(PDFName.of("V")));
    if (value && value !== PDFNull) {
      throw new Error("No se admiten PDFs con firmas previas o campos de firma ya rellenados.");
    }
  }
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object?.get?.(PDFName.of("Type")) === PDFName.of("Sig")) {
      throw new Error(
        "No se admiten PDFs con firmas previas o campos de firma ya rellenados.",
      );
    }
  }
  const signingTime = new Date();
  const existing = visible?.useExisting !== false && visible ? findSignatureBox(pdf, signatureFields) : undefined;
  const stamp = visible ? await createSignatureAppearance(pdf, visible, signingTime, existing) : undefined;
  const originalFields = form.acroForm.Fields();
  if (originalFields) form.acroForm.dict.set(PDFName.of("Fields"), originalFields);
  pdflibAddPlaceholder({
    pdfDoc: pdf,
    pdfPage: stamp?.page,
    signingTime,
    reason: "Firma electronica",
    contactInfo: "",
    name: "",
    location: "",
    signatureLength: SIGNATURE_BYTES * 2,
    subFilter: "ETSI.CAdES.detached",
    widgetRect: stamp?.rect ?? [0, 0, 0, 0],
  });
  const page = stamp?.page ?? pdf.getPages()[0];
  const annotations = page.node.lookup(PDFName.of("Annots"), PDFArray);
  const createdRef = annotations.get(annotations.size() - 1);
  const createdWidget = pdf.context.lookup(createdRef);
  if (existing) {
    existing.field.acroField.dict.set(PDFName.of("V"), createdWidget.get(PDFName.of("V")));
    annotations.remove(annotations.size() - 1);
    const fields = form.acroForm.Fields();
    const createdIndex = fields.indexOf(createdRef);
    if (createdIndex === undefined) throw new Error("No se pudo reutilizar el campo de firma existente.");
    fields.remove(createdIndex);
    pdf.context.delete(createdRef);
  } else {
    const names = new Set(formFields.map(field => field.getName()));
    let suffix = 1;
    while (names.has(`Signature${suffix}`)) suffix++;
    createdWidget.set(PDFName.of("T"), PDFString.of(`Signature${suffix}`));
  }
  if (stamp) {
    const widget = existing?.widget.dict ?? createdWidget;
    widget.set(PDFName.of("AP"), pdf.context.obj({ N: stamp.appearanceRef }));
    widget.delete(PDFName.of("AS"));
    widget.set(PDFName.of("F"), PDFNumber.of((widget.lookup(PDFName.of("F"))?.asNumber?.() ?? 0) | 4));
  }
  const buffer = Buffer.from(await pdf.save({ useObjectStreams: false }));
  const { byteRangePlaceholder } = findByteRange(buffer);
  if (!byteRangePlaceholder) throw new Error("No se encontro el ByteRange.");
  const rangeOffset = buffer.indexOf(byteRangePlaceholder);
  const contentsLabel = buffer.indexOf("/Contents", rangeOffset);
  const contentsStart = buffer.indexOf("<", contentsLabel);
  const contentsEnd = buffer.indexOf(">", contentsStart);
  if (
    contentsLabel < 0 ||
    contentsStart < 0 ||
    contentsEnd < 0 ||
    contentsEnd - contentsStart - 1 !== SIGNATURE_BYTES * 2
  ) {
    throw new Error("Placeholder de firma incorrecto.");
  }
  buffer.fill("0", contentsStart + 1, contentsEnd);

  // ByteRange incluye todo salvo <Contents>, incluidos sus delimitadores < y >.
  // Sustituimos el rango sin cambiar su longitud: no se desplazan objetos ni xref.
  const byteRange = [
    0,
    contentsStart,
    contentsEnd + 1,
    buffer.length - contentsEnd - 1,
  ];
  const replacement = `/ByteRange [${byteRange.join(" ")}]`;
  if (replacement.length > byteRangePlaceholder.length)
    throw new Error("ByteRange demasiado grande.");
  buffer.write(
    replacement.padEnd(byteRangePlaceholder.length, " "),
    rangeOffset,
    "ascii",
  );
  // El hash se calcula DESPUES de fijar ByteRange. Nunca se vuelve a guardar con pdf-lib.
  const hashBase64 = hashPdf(buffer, byteRange).toString("base64");
  return { buffer, byteRange, contentsStart, contentsEnd, hashBase64,
    signerCertificateFingerprint: visible?.certificateFingerprint };
}

export function hashPdf(buffer, byteRange) {
  return createHash("sha256")
    .update(buffer.subarray(byteRange[0], byteRange[0] + byteRange[1]))
    .update(buffer.subarray(byteRange[2], byteRange[2] + byteRange[3]))
    .digest();
}

export function signedBytes(document) {
  const { buffer, byteRange } = document;
  return Buffer.concat([
    buffer.subarray(0, byteRange[1]),
    buffer.subarray(byteRange[2]),
  ]);
}

export function injectPdf(document, signature) {
  if (signature.length > SIGNATURE_BYTES)
    throw new Error("El CMS supera el hueco de 16 KiB.");
  const result = Buffer.from(document.buffer);
  const hex = signature.toString("hex").padEnd(SIGNATURE_BYTES * 2, "0");
  result.write(hex, document.contentsStart + 1, "ascii");
  if (
    hashPdf(result, document.byteRange).toString("base64") !==
    document.hashBase64
  ) {
    throw new Error("El documento preparado ha cambiado.");
  }
  return result;
}
