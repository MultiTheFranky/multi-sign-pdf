import { createHash, webcrypto } from "node:crypto";
import * as asn1js from "asn1js";
import {
  ContentInfo,
  SignedData,
  Certificate,
  CryptoEngine,
  setEngine,
} from "pkijs";
import { SIGNATURE_BYTES, signedBytes } from "./pdf.js";
import { certificateFingerprint } from "./certificate.js";

setEngine(
  "node",
  webcrypto,
  new CryptoEngine({ name: "node", crypto: webcrypto }),
);
export const OIDS = {
  signedData: "1.2.840.113549.1.7.2",
  sha256: "2.16.840.1.101.3.4.2.1",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
};

export function decodeSignature(value) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > Math.ceil(SIGNATURE_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) ||
    value.length % 4 === 1
  ) {
    throw new Error(
      "signatureBase64 no es un CMS Base64 valido de hasta 16 KiB.",
    );
  }
  const buffer = Buffer.from(value, "base64");
  if (
    !buffer.length ||
    buffer.length > SIGNATURE_BYTES ||
    buffer.toString("base64").replace(/=+$/, "") !==
      value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "")
  ) {
    throw new Error("Codificacion Base64 incorrecta.");
  }
  return buffer;
}

export async function verifyCms(signature, document) {
  try {
    const parsed = asn1js.fromBER(signature);
    if (parsed.offset !== signature.length)
      throw new Error("DER incompleto o bytes adicionales.");
    const info = new ContentInfo({ schema: parsed.result });
    if (info.contentType !== OIDS.signedData)
      throw new Error("Se requiere CMS SignedData, no PKCS#1 aislado.");
    const cms = new SignedData({ schema: info.content });
    if (
      cms.encapContentInfo.eContent ||
      cms.signerInfos.length !== 1 ||
      cms.encapContentInfo.eContentType !== "1.2.840.113549.1.7.1"
    ) {
      throw new Error("Se requiere un CMS detached con un unico firmante.");
    }
    const signer = cms.signerInfos[0];
    if (
      signer.digestAlgorithm.algorithmId !== OIDS.sha256 ||
      !signer.signedAttrs
    ) {
      throw new Error("Se requieren SHA-256 y atributos firmados CAdES.");
    }
    const forbidden = ["1.2.840.113549.1.9.5", "1.2.840.113549.1.9.16.2.4"];
    if (
      signer.signedAttrs.attributes.some((attribute) =>
        forbidden.includes(attribute.type),
      )
    ) {
      throw new Error("PAdES no admite signingTime ni content-hint en el CMS.");
    }
    const result = await cms.verify({
      signer: 0,
      data: signedBytes(document),
      checkChain: false,
      extendedMode: true,
    });
    if (
      !result.signatureVerified ||
      !(result.signerCertificate instanceof Certificate)
    ) {
      throw new Error("La firma no corresponde al ByteRange del documento.");
    }
    const certificate = result.signerCertificate;
    const now = new Date();
    if (now < certificate.notBefore.value || now > certificate.notAfter.value) {
      throw new Error("El certificado esta caducado o aun no es valido.");
    }
    if (
      document.signerCertificateFingerprint &&
      certificateFingerprint(certificate) !==
        document.signerCertificateFingerprint
    ) {
      throw new Error(
        "El certificado firmante no coincide con el usado en la firma visible.",
      );
    }
    const attributes = signer.signedAttrs.attributes.filter(
      (attribute) => attribute.type === OIDS.signingCertificateV2,
    );
    if (attributes.length !== 1 || attributes[0].values.length !== 1) {
      throw new Error("Falta signingCertificateV2 para el perfil CAdES.");
    }
    const signingCertificate = attributes[0].values[0];
    if (!(signingCertificate instanceof asn1js.Sequence))
      throw new Error("SigningCertificateV2 invalido.");
    const certs = signingCertificate.valueBlock.value[0];
    const certId = certs?.valueBlock.value[0];
    if (
      !(certs instanceof asn1js.Sequence) ||
      !(certId instanceof asn1js.Sequence)
    ) {
      throw new Error("ESSCertIDv2 invalido.");
    }
    const fields = certId.valueBlock.value;
    let hashIndex = 0;
    if (fields[0] instanceof asn1js.Sequence) {
      if (
        fields[0].valueBlock.value[0]?.valueBlock.toString() !== OIDS.sha256
      ) {
        throw new Error("ESSCertIDv2 debe usar SHA-256.");
      }
      hashIndex = 1;
    }
    const certHash = fields[hashIndex];
    const expected = createHash("sha256")
      .update(Buffer.from(certificate.toSchema().toBER(false)))
      .digest();
    if (
      !(certHash instanceof asn1js.OctetString) ||
      !expected.equals(Buffer.from(certHash.valueBlock.valueHexView))
    ) {
      throw new Error(
        "El atributo CAdES no corresponde al certificado firmante.",
      );
    }
    return certificate;
  } catch (error) {
    throw new Error(`CMS rechazado: ${error.message}`);
  }
}
