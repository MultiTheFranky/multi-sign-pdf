import { createHash } from "node:crypto";
import { PDFDocument, PDFName } from "pdf-lib";
import placeholder from "@signpdf/placeholder-pdf-lib";
import signUtils from "@signpdf/utils";

const { pdflibAddPlaceholder } = placeholder;
const { findByteRange } = signUtils;
export const SIGNATURE_BYTES = 16384;

export async function preparePdf(input) {
  if (!input.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    throw new Error("El archivo no es un PDF.");
  }
  const pdf = await PDFDocument.load(input, { updateMetadata: false });
  if (!pdf.getPageCount()) throw new Error("El PDF no contiene paginas.");
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (
      object?.get?.(PDFName.of("FT")) === PDFName.of("Sig") ||
      object?.get?.(PDFName.of("Type")) === PDFName.of("Sig")
    ) {
      throw new Error(
        "No se admiten PDFs con firmas o campos de firma previos.",
      );
    }
  }
  pdflibAddPlaceholder({
    pdfDoc: pdf,
    reason: "Firma electronica",
    contactInfo: "",
    name: "",
    location: "",
    signatureLength: SIGNATURE_BYTES * 2,
    subFilter: "ETSI.CAdES.detached",
    widgetRect: [0, 0, 0, 0],
  });
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
  return { buffer, byteRange, contentsStart, contentsEnd, hashBase64 };
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
