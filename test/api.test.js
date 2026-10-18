import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as asn1js from "asn1js";
import {
  ContentInfo,
  SignedData,
  SignerInfo,
  IssuerAndSerialNumber,
  SignedAndUnsignedAttributes,
  Attribute,
} from "pkijs";
import request from "supertest";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { createApp } from "../server/app.js";
import { DocumentStore } from "../server/store.js";
import { signedBytes, preparePdf } from "../server/pdf.js";
import { OIDS, verifyCms, decodeSignature } from "../server/cms.js";
import { certificateBase64, testIdentity } from "../test-support/certificate.js";

async function samplePdf({ signatureBox = false } = {}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  page.drawText("Factura 2026");
  if (signatureBox) {
    const form = pdf.getForm();
    const field = pdf.context.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig",
      T: PDFString.of("Firma original"), Rect: [50, 100, 230, 145], F: 4, P: page.ref });
    const ref = pdf.context.register(field);
    page.node.addAnnot(ref);
    form.acroForm.addField(ref);
  }
  return Buffer.from(await pdf.save());
}

async function signCms(
  document,
  identity,
  { badCertHash = false, omitEss = false, signingTime = false } = {},
) {
  const { keys, certificate } = identity;
  const certHash = createHash("sha256")
    .update(Buffer.from(certificate.toSchema().toBER(false)))
    .digest();
  if (badCertHash) certHash[0] ^= 1;
  const attributes = [
    new Attribute({
      type: "1.2.840.113549.1.9.3",
      values: [new asn1js.ObjectIdentifier({ value: "1.2.840.113549.1.7.1" })],
    }),
    new Attribute({
      type: "1.2.840.113549.1.9.4",
      values: [
        new asn1js.OctetString({
          valueHex: createHash("sha256").update(signedBytes(document)).digest(),
        }),
      ],
    }),
  ];
  if (signingTime)
    attributes.push(
      new Attribute({
        type: "1.2.840.113549.1.9.5",
        values: [new asn1js.UTCTime({ valueDate: new Date() })],
      }),
    );
  if (!omitEss)
    attributes.push(
      new Attribute({
        type: OIDS.signingCertificateV2,
        values: [
          new asn1js.Sequence({
            value: [
              new asn1js.Sequence({
                value: [
                  new asn1js.Sequence({
                    value: [new asn1js.OctetString({ valueHex: certHash })],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    );
  const cms = new SignedData({
    version: 1,
    certificates: [certificate],
    signerInfos: [
      new SignerInfo({
        version: 1,
        sid: new IssuerAndSerialNumber({
          issuer: certificate.issuer,
          serialNumber: certificate.serialNumber,
        }),
        signedAttrs: new SignedAndUnsignedAttributes({ type: 0, attributes }),
      }),
    ],
  });
  cms.encapContentInfo.eContentType = "1.2.840.113549.1.7.1";
  await cms.sign(keys.privateKey, 0, "SHA-256", signedBytes(document));
  return Buffer.from(
    new ContentInfo({
      contentType: OIDS.signedData,
      content: cms.toSchema(true),
    })
      .toSchema()
      .toBER(false),
  );
}

test("flujo HTTP completo, CMS real, firma de otro PDF y consumo unico", async () => {
  const { app, store } = createApp();
  try {
    const identity = await testIdentity();
    const prepared = await request(app)
      .post("/api/pdf/prepare")
      .field("visibleSignature", JSON.stringify({ certificateBase64: certificateBase64(identity), page: "last", position: "bottom-right" }))
      .attach("files", await samplePdf({ signatureBox: true }), "factura.pdf")
      .expect(201);
    const { documentId, hashBase64 } = prepared.body[0];
    assert.equal(Buffer.from(hashBase64, "base64").length, 32);
    const document = store.get(documentId);
    const cms = await signCms(document, identity);
    const changedCertificate = await signCms(document, await testIdentity());
    const mismatched = await request(app).post("/api/pdf/inject")
      .send({ documentId, signatureBase64: changedCertificate.toString("base64") }).expect(422);
    assert.match(mismatched.body.error, /no coincide/);
    const other = await preparePdf(await samplePdf());
    other.buffer[20] ^= 1;
    const wrongCms = await signCms(other, identity);
    await request(app)
      .post("/api/pdf/inject")
      .send({ documentId, signatureBase64: wrongCms.toString("base64") })
      .expect(422);
    assert.ok(store.get(documentId));
    const signed = await request(app)
      .post("/api/pdf/inject")
      .send({ documentId, signatureBase64: cms.toString("base64") })
      .expect(200);
    assert.match(signed.headers["content-type"], /application\/pdf/);
    assert.equal(signed.body.length, document.buffer.length);
    await verifyCms(cms, { ...document, buffer: signed.body });
    const signedPdf = await PDFDocument.load(signed.body);
    assert.equal(signedPdf.getForm().getFields().length, 1);
    const widget = signedPdf.getForm().getSignature("Firma original").acroField.getWidgets()[0];
    assert.equal(widget.getRectangle().width, 180);
    assert.equal(widget.getRectangle().height, 45);
    await request(app)
      .post("/api/pdf/inject")
      .send({ documentId, signatureBase64: cms.toString("base64") })
      .expect(404);
  } finally {
    store.close();
  }
});

test("rechaza atributos CAdES ausentes, certificado no vinculado y firma alterada", async () => {
  const document = await preparePdf(await samplePdf());
  const identity = await testIdentity();
  await assert.rejects(
    verifyCms(await signCms(document, identity, { omitEss: true }), document),
    /signingCertificateV2/,
  );
  await assert.rejects(
    verifyCms(
      await signCms(document, identity, { signingTime: true }),
      document,
    ),
    /PAdES no admite/,
  );
  await assert.rejects(
    verifyCms(
      await signCms(document, identity, { badCertHash: true }),
      document,
    ),
    /no corresponde al certificado/,
  );
  const cms = await signCms(document, identity);
  cms[cms.length - 1] ^= 1;
  await assert.rejects(verifyCms(cms, document));
  assert.throws(() => decodeSignature("invalid!"), /Base64/);
});

test("lote atomico, limites del almacen, caducidad y origen", async () => {
  const store = new DocumentStore({ ttlMs: 1000, maxBytes: 100000 });
  const { app } = createApp({ store, appOrigin: "https://firma.example" });
  try {
    await request(app)
      .post("/api/pdf/prepare")
      .attach("files", await samplePdf(), "bien.pdf")
      .attach("files", Buffer.from("no pdf"), "mal.pdf")
      .expect(422);
    assert.equal(store.documents.size, 0);
    await request(app)
      .post("/api/pdf/prepare")
      .set("Origin", "https://otro.example")
      .expect(403);
    await request(app).post("/api/pdf/prepare").expect(400);
    const document = await preparePdf(await samplePdf());
    const [{ documentId }] = store.addBatch([
      { ...document, filename: "test.pdf" },
    ]);
    store.get(documentId).expiresAt = 0;
    assert.equal(store.get(documentId), undefined);
    assert.equal(store.bytes, 0);
    store.maxBytes = 1;
    assert.throws(() => store.addBatch([document]), /lleno/);
  } finally {
    store.close();
  }
});

test("preparacion valida el campo JSON de firma visible sin guardar entradas invalidas", async () => {
  const { app, store } = createApp();
  try {
    const input = await samplePdf();
    const selectedCertificate = certificateBase64(await testIdentity());
    for (const value of ["{", "null", JSON.stringify({ dni: "" }),
      JSON.stringify({ certificateBase64: selectedCertificate, position: "outside" })]) {
      await request(app).post("/api/pdf/prepare")
        .field("visibleSignature", value).attach("files", input, "documento.pdf").expect(400);
    }
    assert.equal(store.documents.size, 0);
    const response = await request(app).post("/api/pdf/prepare")
      .attach("files", input, "invisible.pdf").expect(201);
    const pdf = await PDFDocument.load(store.get(response.body[0].documentId).buffer);
    assert.equal(pdf.getForm().getSignature("Signature1").acroField.getWidgets()[0].getRectangle().width, 0);
  } finally { store.close(); }
});
