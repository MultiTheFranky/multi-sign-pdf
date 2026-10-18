import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { preparePdf, injectPdf, SIGNATURE_BYTES } from "../server/pdf.js";

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
  await assert.rejects(preparePdf(result), /firmas o campos/);
});

test("rechaza entrada no PDF y firmas que no caben", async () => {
  await assert.rejects(preparePdf(Buffer.from("no pdf")), /no es un PDF/);
  const prepared = await preparePdf(await samplePdf());
  assert.throws(
    () => injectPdf(prepared, Buffer.alloc(SIGNATURE_BYTES + 1)),
    /16 KiB/,
  );
});
