import { webcrypto } from "node:crypto";
import * as asn1js from "asn1js";
import { AttributeTypeAndValue, Certificate } from "pkijs";
import "../server/cms.js";

export async function testIdentity({ dni = "12345678Z", commonName = "Solo pruebas", expiresAt } = {}) {
  const keys = await webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const certificate = new Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({ value: 1 });
  const attributes = [new AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.Utf8String({ value: commonName }) })];
  if (dni !== null) attributes.push(new AttributeTypeAndValue({ type: "2.5.4.5", value: new asn1js.PrintableString({ value: dni }) }));
  certificate.issuer.typesAndValues.push(...attributes);
  certificate.subject.typesAndValues.push(...attributes);
  certificate.notBefore.value = new Date(Date.now() - 3600000);
  certificate.notAfter.value = expiresAt ?? new Date(Date.now() + 3600000);
  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey);
  await certificate.sign(keys.privateKey, "SHA-256");
  return { keys, certificate };
}

export function certificateBase64(identity) {
  return Buffer.from(identity.certificate.toSchema().toBER(false)).toString("base64");
}