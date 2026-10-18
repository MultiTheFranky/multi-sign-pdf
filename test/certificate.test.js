import test from "node:test";
import assert from "node:assert/strict";
import { signingIdentity } from "../server/certificate.js";
import { certificateBase64, testIdentity } from "../test-support/certificate.js";

test("extrae DNI/NIE del certificado seleccionado y calcula su huella", async () => {
  for (const [subject, expected] of [["12345678Z", "12345678Z"], ["IDCES-12345678Z", "12345678Z"], ["PNOES-X1234567L", "X1234567L"]]) {
    const identity = await testIdentity({ dni: subject });
    const result = signingIdentity(certificateBase64(identity));
    assert.equal(result.dni, expected);
    assert.match(result.certificateFingerprint, /^[a-f0-9]{64}$/);
  }
});

test("acepta DNI en CN y rechaza identidades ambiguas, certificados invalidos y caducados", async () => {
  const fallback = await testIdentity({ dni: null, commonName: "Solo pruebas - 12345678Z" });
  assert.equal(signingIdentity(certificateBase64(fallback)).dni, "12345678Z");
  for (const commonName of ["Solo pruebas", "12345678Z / X1234567L"]) {
    const identity = await testIdentity({ dni: null, commonName });
    assert.throws(() => signingIdentity(certificateBase64(identity)), /inequivoco/);
  }
  const expired = await testIdentity({ expiresAt: new Date(Date.now() - 60000) });
  assert.throws(() => signingIdentity(certificateBase64(expired)), /caducado/);
  assert.throws(() => signingIdentity("not-a-certificate!"), /certificado/);
});