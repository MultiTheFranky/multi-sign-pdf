import { createHash } from "node:crypto";
import * as asn1js from "asn1js";
import { Certificate } from "pkijs";

export function certificateFingerprint(certificate) {
  return createHash("sha256").update(Buffer.from(certificate.toSchema().toBER(false))).digest("hex");
}

export function signingIdentity(certificateBase64) {
  if (typeof certificateBase64 !== "string" || !certificateBase64.length ||
      certificateBase64.length > 43692 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(certificateBase64)) {
    throw new Error("Selecciona un certificado de AutoFirma valido.");
  }
  const bytes = Buffer.from(certificateBase64, "base64");
  const normalized = certificateBase64.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!bytes.length || bytes.length > 32768 || bytes.toString("base64").replace(/=+$/, "") !== normalized) {
    throw new Error("Certificado Base64 no valido.");
  }
  const parsed = asn1js.fromBER(bytes);
  if (parsed.offset !== bytes.length) throw new Error("Certificado DER no valido.");
  const certificate = new Certificate({ schema: parsed.result });
  const now = new Date();
  if (now < certificate.notBefore.value || now > certificate.notAfter.value) {
    throw new Error("El certificado esta caducado o aun no es valido.");
  }
  let candidates;
  for (const oid of ["2.5.4.5", "2.5.4.3"]) {
    candidates = new Set(certificate.subject.typesAndValues.filter(attribute => attribute.type === oid)
      .flatMap(attribute => Array.from(String(attribute.value.valueBlock.value).toUpperCase()
        .matchAll(/(?:^|[^A-Z0-9])(?:IDCES-|PNOES-)?((?:\d{8}|[XYZ]\d{7})[A-Z])(?=$|[^A-Z0-9])/g), match => match[1])));
    if (candidates.size) break;
  }
  if (candidates.size !== 1) throw new Error("El certificado no contiene un DNI/NIE inequivoco para la firma visible.");
  return { dni: [...candidates][0], certificateFingerprint: certificateFingerprint(certificate) };
}