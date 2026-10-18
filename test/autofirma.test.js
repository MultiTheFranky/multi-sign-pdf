import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import {
  normalizeBatchResult,
  signHashes,
  withSigningCertificate,
} from "../src/autofirma.js";

test("biblioteca oficial integra, script clasico y configuracion local", () => {
  const source = readFileSync(
    new URL("../public/autofirma/autoscript.js", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "567998128f1cd8017c304a8c187f6912a0c56b0feebb02fffa2aa33732e40439",
  );
  const context = createContext({
    window: { location: { hostname: "localhost" } },
    document: { all: false },
    navigator: { userAgent: "", appVersion: "" },
    console,
  });
  new Script(source.toString("utf8"), {
    filename: "autoscript.js",
  }).runInContext(context, { timeout: 2000 });
  assert.equal(context.AutoScript.VERSION, "1.9.0");
  assert.equal(context.MiniApplet, context.AutoScript);
  for (const method of [
    "createBatch",
    "addDocumentToBatch",
    "setLocalBatchProcess",
    "signBatchProcess",
    "selectCertificate",
    "setStickySignatory",
  ]) {
    assert.equal(typeof context.AutoScript[method], "function");
  }
  new Script(
    readFileSync(new URL("../public/config.js", import.meta.url), "utf8"),
  ).runInContext(context);
  assert.equal(
    context.window.SIGNER_CONFIG.autofirmaScriptUrl,
    "/autofirma/autoscript.js",
  );
});

test("lote local con API oficial, hashes precalculados y resultados por id", async () => {
  const calls = [];
  globalThis.window = {
    AutoScript: {
      cargarAppAfirma: (...args) => calls.push(["init", ...args]),
      setLocalBatchProcess: (value) => calls.push(["local", value]),
      createBatch: (...args) => calls.push(["create", ...args]),
      addDocumentToBatch: (...args) => calls.push(["add", ...args]),
      signBatchProcess: (stop, pre, post, filters, success) => {
        calls.push(["sign", stop, pre, post, filters]);
        success({
          signs: [
            { id: "two", result: "ERROR_PRE", description: "Error de tarjeta" },
            { id: "one", result: "DONE_AND_SAVED", signature: "Y21z" },
          ],
        });
      },
    },
  };
  try {
    const result = await signHashes([
      { documentId: "one", hashBase64: "aGFzaA==" },
      { documentId: "two", hashBase64: "b3Rybw==" },
    ]);
    assert.equal(result[0].signatureBase64, "Y21z");
    assert.equal(result[1].error, "Error de tarjeta");
    assert.ok(
      calls.some(
        (call) =>
          call[0] === "create" &&
          call[1] === "SHA256withRSA" &&
          call[4].includes("precalculatedHashAlgorithm=SHA-256") &&
          call[4].includes("includeSigningTimeAttribute=false"),
      ),
    );
    assert.deepEqual(
      calls.filter((call) => call[0] === "add"),
      [
        ["add", "one", "aGFzaA=="],
        ["add", "two", "b3Rybw=="],
      ],
    );
    assert.deepEqual(calls.at(-1), ["local", false]);
  } finally {
    delete globalThis.window;
  }
});

test("cancelacion y restauracion del modo local", async () => {
  const modes = [];
  globalThis.window = {
    MiniApplet: {
      setLocalBatchProcess: (value) => modes.push(value),
      createBatch() {},
      addDocumentToBatch() {},
      signBatchProcess: (_stop, _pre, _post, _filters, _success, error) =>
        error("AOCancelledOperationException", "cancelado"),
    },
  };
  try {
    await assert.rejects(
      signHashes([{ documentId: "one", hashBase64: "aGFzaA==" }]),
      { name: "AbortError" },
    );
    assert.deepEqual(modes, [true, false]);
    assert.throws(
      () => normalizeBatchResult({ signs: [{ id: "one" }, { id: "one" }] }, []),
      /duplicados/,
    );
    assert.throws(() => normalizeBatchResult({}, []), /no valido/);
  } finally {
    delete globalThis.window;
  }
});

test("selecciona un certificado antes de preparar y fija el mismo para todo el lote", async () => {
  const calls = [];
  globalThis.window = {
    AutoScript: {
      setStickySignatory: (value) => calls.push(["sticky", value]),
      selectCertificate: (_params, success) => {
        calls.push(["select"]);
        success("Y2VydA==");
      },
      setLocalBatchProcess: (value) => calls.push(["local", value]),
      createBatch() {},
      addDocumentToBatch() {},
      signBatchProcess: (_stop, _pre, _post, filters, success) => {
        calls.push(["sign", filters]);
        success({
          signs: [{ id: "one", result: "DONE_AND_SAVED", signature: "Y21z" }],
        });
      },
    },
  };
  try {
    await withSigningCertificate(async (session) => {
      assert.equal(session.certificateBase64, "Y2VydA==");
      assert.equal(calls.filter((call) => call[0] === "select").length, 1);
      await assert.rejects(signHashes([]), /en curso/);
      const results = await session.sign([
        { documentId: "one", hashBase64: "aGFzaA==" },
      ]);
      assert.equal(results[0].signatureBase64, "Y21z");
    });
    assert.deepEqual(
      calls.find((call) => call[0] === "sign"),
      ["sign", "filters=encodedcert:Y2VydA==\nheadless=true"],
    );
    assert.deepEqual(calls.at(-1), ["sticky", false]);
  } finally {
    delete globalThis.window;
  }
});

test("cancelar el certificado no prepara PDFs y libera la seleccion fijada", async () => {
  const sticky = [];
  globalThis.window = {
    MiniApplet: {
      setStickySignatory: (value) => sticky.push(value),
      selectCertificate: (_params, _success, failure) =>
        failure("AOCancelledOperationException", "cancelado"),
      setLocalBatchProcess() {},
      createBatch() {},
      addDocumentToBatch() {},
      signBatchProcess() {},
    },
  };
  let prepared = false;
  try {
    await assert.rejects(
      withSigningCertificate(() => {
        prepared = true;
      }),
      { name: "AbortError" },
    );
    assert.equal(prepared, false);
    assert.deepEqual(sticky, [false, true, false]);
  } finally {
    delete globalThis.window;
  }
});
