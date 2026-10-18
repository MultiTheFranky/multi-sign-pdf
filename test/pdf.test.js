import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
  degrees,
} from "pdf-lib";
import { preparePdf, injectPdf, SIGNATURE_BYTES } from "../server/pdf.js";
import {
  certificateBase64,
  testIdentity,
} from "../test-support/certificate.js";

const selectedCertificate = certificateBase64(await testIdentity());

export async function samplePdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText("Documento de prueba");
  return Buffer.from(await pdf.save());
}

test("ByteRange cubre el PDF salvo los 16 KiB hex y sus delimitadores", async () => {
  const prepared = await preparePdf(await samplePdf());
  const { buffer, byteRange, contentsStart, contentsEnd } = prepared;
  assert.equal(contentsEnd - contentsStart - 1, SIGNATURE_BYTES * 2);
  assert.equal(buffer[contentsStart], 60);
  assert.equal(buffer[contentsEnd], 62);
  assert.equal(byteRange[2] + byteRange[3], buffer.length);
  const independentHash = createHash("sha256")
    .update(
      Buffer.concat([
        buffer.subarray(0, contentsStart),
        buffer.subarray(contentsEnd + 1),
      ]),
    )
    .digest("base64");
  assert.equal(prepared.hashBase64, independentHash);
  const result = injectPdf(prepared, Buffer.from("30820100", "hex"));
  assert.equal(result.length, buffer.length);
  assert.deepEqual(
    result.subarray(0, contentsStart + 1),
    buffer.subarray(0, contentsStart + 1),
  );
  assert.deepEqual(result.subarray(contentsEnd), buffer.subarray(contentsEnd));
  assert.equal((await PDFDocument.load(result)).getPageCount(), 1);
  await assert.rejects(preparePdf(result), /firmas previas/);
});

test("rechaza entrada no PDF y firmas que no caben", async () => {
  await assert.rejects(preparePdf(Buffer.from("no pdf")), /no es un PDF/);
  const prepared = await preparePdf(await samplePdf());
  assert.throws(
    () => injectPdf(prepared, Buffer.alloc(SIGNATURE_BYTES + 1)),
    /16 KiB/,
  );
});

test("firma visible con DNI y fecha, pagina seleccionada y ByteRange estable", async () => {
  const source = await PDFDocument.create();
  source.addPage();
  source.addPage();
  const prepared = await preparePdf(Buffer.from(await source.save()), {
    visibleSignature: {
      certificateBase64: selectedCertificate,
      dni: "X1234567L",
      page: "last",
      position: "bottom-right",
    },
  });
  const pdf = await PDFDocument.load(prepared.buffer);
  assert.equal(pdf.getPages()[0].node.get(PDFName.of("Annots")), undefined);
  const annotations = pdf
    .getPages()[1]
    .node.lookup(PDFName.of("Annots"), PDFArray);
  const widget = pdf.context.lookup(annotations.get(0));
  const rect = widget
    .lookup(PDFName.of("Rect"), PDFArray)
    .asArray()
    .map((value) => value.asNumber());
  assert.equal(rect[2] - rect[0], 250);
  assert.equal(rect[3] - rect[1], 76);
  const appearance = widget.lookup(PDFName.of("AP")).lookup(PDFName.of("N"));
  const content = Buffer.from(decodePDFRawStream(appearance).decode()).toString(
    "ascii",
  );
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  assert.ok(content.includes(font.encodeText("DNI/NIE: 12345678Z").toString()));
  const signingDate = widget
    .lookup(PDFName.of("V"))
    .lookup(PDFName.of("M"))
    .decodeDate();
  const dateText = `Fecha: ${signingDate.toISOString().slice(0, 19).replace("T", " ")} UTC`;
  assert.ok(content.includes(font.encodeText(dateText).toString()));
  const result = injectPdf(prepared, Buffer.from("30820100", "hex"));
  assert.deepEqual(
    result.subarray(0, prepared.contentsStart),
    prepared.buffer.subarray(0, prepared.contentsStart),
  );
  assert.deepEqual(
    result.subarray(prepared.contentsEnd + 1),
    prepared.buffer.subarray(prepared.contentsEnd + 1),
  );
});

test("firma visible respeta CropBox y rotaciones de pagina", async () => {
  for (const rotation of [0, 90, 180, 270]) {
    const source = await PDFDocument.create();
    const page = source.addPage([700, 900]);
    page.setCropBox(40, 60, 500, 700);
    page.setRotation(degrees(rotation));
    const prepared = await preparePdf(Buffer.from(await source.save()), {
      visibleSignature: {
        certificateBase64: selectedCertificate,
        page: "first",
        position: "top-left",
      },
    });
    const pdf = await PDFDocument.load(prepared.buffer);
    const annotations = pdf
      .getPages()[0]
      .node.lookup(PDFName.of("Annots"), PDFArray);
    const widget = pdf.context.lookup(annotations.get(0));
    const rect = widget
      .lookup(PDFName.of("Rect"), PDFArray)
      .asArray()
      .map((value) => value.asNumber());
    assert.ok(
      rect[0] >= 40 && rect[1] >= 60 && rect[2] <= 540 && rect[3] <= 760,
    );
    const appearance = widget.lookup(PDFName.of("AP")).lookup(PDFName.of("N"));
    const matrix = appearance.dict
      .lookup(PDFName.of("Matrix"), PDFArray)
      .asArray()
      .map((value) => value.asNumber());
    assert.ok(
      Math.abs(matrix[0] - Math.cos((rotation * Math.PI) / 180)) < 0.001,
    );
    assert.ok(
      Math.abs(matrix[1] - Math.sin((rotation * Math.PI) / 180)) < 0.001,
    );
  }
});

test("rechaza certificado, pagina, posicion y tamanos no validos", async () => {
  const input = await samplePdf();
  await assert.rejects(
    preparePdf(input, { visibleSignature: { dni: "12345678Z" } }),
    /certificado/,
  );
  await assert.rejects(
    preparePdf(input, {
      visibleSignature: {
        certificateBase64: selectedCertificate,
        page: "other",
      },
    }),
    /Pagina o posicion/,
  );
  await assert.rejects(
    preparePdf(input, {
      visibleSignature: {
        certificateBase64: selectedCertificate,
        position: "outside",
      },
    }),
    /Pagina o posicion/,
  );
  const small = await PDFDocument.create();
  small.addPage([100, 100]);
  await assert.rejects(
    preparePdf(Buffer.from(await small.save()), {
      visibleSignature: { certificateBase64: selectedCertificate },
    }),
    /demasiado pequena/,
  );
});

function addEmptySignature(
  pdf,
  page,
  name,
  rect,
  { flags = 4, readOnly = false, split = false } = {},
) {
  const form = pdf.getForm();
  const field = pdf.context.obj({
    FT: "Sig",
    T: PDFString.of(name),
    Ff: readOnly ? 1 : 0,
  });
  const fieldRef = pdf.context.register(field);
  const widget = split
    ? pdf.context.obj({ Type: "Annot", Subtype: "Widget", Parent: fieldRef })
    : field;
  const widgetRef = split ? pdf.context.register(widget) : fieldRef;
  widget.set(PDFName.of("Type"), PDFName.of("Annot"));
  widget.set(PDFName.of("Subtype"), PDFName.of("Widget"));
  widget.set(PDFName.of("Rect"), pdf.context.obj(rect));
  widget.set(PDFName.of("F"), PDFNumber.of(flags));
  widget.set(PDFName.of("P"), page.ref);
  if (split) field.set(PDFName.of("Kids"), pdf.context.obj([widgetRef]));
  page.node.addAnnot(widgetRef);
  form.acroForm.addField(fieldRef);
  return { field, widget };
}

test("reutiliza la casilla vacia original sin duplicar campos ni anotaciones", async () => {
  for (const split of [false, true]) {
    const source = await PDFDocument.create();
    const page = source.addPage();
    source.addPage();
    const name = split ? "Firma del solicitante" : "Signature1";
    addEmptySignature(source, page, name, [81, 240, 261, 285], { split });
    const prepared = await preparePdf(Buffer.from(await source.save()), {
      visibleSignature: {
        certificateBase64: selectedCertificate,
        page: "last",
        position: "bottom-right",
      },
    });
    const pdf = await PDFDocument.load(prepared.buffer);
    const fields = pdf.getForm().getFields();
    assert.equal(fields.length, 1);
    assert.equal(fields[0].getName(), name);
    assert.ok(fields[0].acroField.dict.get(PDFName.of("V")));
    const widget = fields[0].acroField.getWidgets()[0];
    assert.deepEqual(widget.getRectangle(), {
      x: 81,
      y: 240,
      width: 180,
      height: 45,
    });
    assert.equal(
      pdf.getPages()[0].node.lookup(PDFName.of("Annots"), PDFArray).size(),
      1,
    );
    assert.equal(pdf.getPages()[1].node.get(PDFName.of("Annots")), undefined);
    const appearance = widget.dict
      .lookup(PDFName.of("AP"))
      .lookup(PDFName.of("N"));
    const content = Buffer.from(
      decodePDFRawStream(appearance).decode(),
    ).toString("ascii");
    assert.ok(
      content.includes(
        Buffer.from("DNI/NIE: 12345678Z").toString("hex").toUpperCase(),
      ),
    );
    assert.ok(
      content.includes(Buffer.from("Fecha: ").toString("hex").toUpperCase()),
    );
    const result = injectPdf(prepared, Buffer.from("30820100", "hex"));
    assert.deepEqual(
      result.subarray(0, prepared.contentsStart),
      prepared.buffer.subarray(0, prepared.contentsStart),
    );
    await assert.rejects(preparePdf(result), /firmas previas/);
  }
});

test("elige la primera casilla util en orden de pagina y conserva el resto", async () => {
  const source = await PDFDocument.create();
  const first = source.addPage();
  const last = source.addPage();
  addEmptySignature(source, last, "Segunda", [50, 100, 300, 176]);
  addEmptySignature(source, first, "Primera", [40, 200, 290, 276]);
  const prepared = await preparePdf(Buffer.from(await source.save()), {
    visibleSignature: { certificateBase64: selectedCertificate },
  });
  const pdf = await PDFDocument.load(prepared.buffer);
  assert.equal(pdf.getForm().getFields().length, 2);
  assert.ok(
    pdf.getForm().getSignature("Primera").acroField.dict.get(PDFName.of("V")),
  );
  assert.equal(
    pdf.getForm().getSignature("Segunda").acroField.dict.get(PDFName.of("V")),
    undefined,
  );
});

test("casillas no utilizables y preferencia manual conservan la posicion alternativa", async () => {
  for (const options of [
    { flags: 2 },
    { flags: 32 },
    { readOnly: true },
    { rect: [0, 0, 10, 10] },
    { rect: [-100, 100, 150, 176] },
    { useExisting: false },
  ]) {
    const source = await PDFDocument.create();
    const page = source.addPage();
    addEmptySignature(
      source,
      page,
      "Original",
      options.rect ?? [40, 100, 290, 176],
      options,
    );
    const prepared = await preparePdf(Buffer.from(await source.save()), {
      visibleSignature: {
        certificateBase64: selectedCertificate,
        useExisting: options.useExisting,
      },
    });
    const pdf = await PDFDocument.load(prepared.buffer);
    assert.equal(pdf.getForm().getFields().length, 2);
    assert.equal(
      pdf
        .getForm()
        .getSignature("Original")
        .acroField.dict.get(PDFName.of("V")),
      undefined,
    );
    const created = pdf
      .getForm()
      .getSignature("Signature1")
      .acroField.getWidgets()[0];
    assert.equal(created.getRectangle().width, 250);
  }
});

test("conserva arrays de campos indirectos y evita nombres duplicados al crear una casilla", async () => {
  const source = await PDFDocument.create();
  const page = source.addPage();
  addEmptySignature(source, page, "Signature1", [50, 100, 300, 176]);
  const form = source.getForm();
  const text = form.createTextField("Referencia");
  text.setText("Solicitud 42");
  text.addToPage(page, { x: 50, y: 300, width: 200, height: 30 });
  form.acroForm.dict.set(
    PDFName.of("Fields"),
    source.context.register(form.acroForm.Fields()),
  );
  const input = Buffer.from(await source.save());
  for (const useExisting of [true, false]) {
    const prepared = await preparePdf(input, {
      visibleSignature: { certificateBase64: selectedCertificate, useExisting },
    });
    const pdf = await PDFDocument.load(prepared.buffer);
    const names = pdf
      .getForm()
      .getFields()
      .map((field) => field.getName());
    assert.equal(names.length, useExisting ? 2 : 3);
    assert.equal(new Set(names).size, names.length);
    assert.equal(
      pdf.getForm().getTextField("Referencia").getText(),
      "Solicitud 42",
    );
    assert.ok(
      pdf
        .getForm()
        .getSignature(useExisting ? "Signature1" : "Signature2")
        .acroField.dict.get(PDFName.of("V")),
    );
  }
});
