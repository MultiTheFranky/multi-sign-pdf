const initializedClients = new WeakSet();
let scriptPromise;
let signing = false;

export function normalizeBatchResult(result, documents) {
  const parsed = typeof result === "string" ? JSON.parse(result) : result;
  if (!Array.isArray(parsed?.signs))
    throw new Error("AutoFirma ha devuelto un lote no valido.");
  const byId = new Map();
  for (const item of parsed.signs) {
    if (byId.has(item.id))
      throw new Error("AutoFirma ha devuelto identificadores duplicados.");
    byId.set(item.id, item);
  }
  return documents.map((document) => {
    const item = byId.get(document.documentId);
    if (
      item?.result === "DONE_AND_SAVED" &&
      typeof item.signature === "string" &&
      item.signature.length
    ) {
      return {
        documentId: document.documentId,
        signatureBase64: item.signature,
      };
    }
    return {
      documentId: document.documentId,
      error:
        item?.description || "AutoFirma no genero la firma de este documento.",
    };
  });
}

async function getClient() {
  const config = window.SIGNER_CONFIG || {};
  if (
    !window.AutoScript &&
    !window.MiniApplet &&
    !window.AutoFirma &&
    config.autofirmaScriptUrl
  ) {
    scriptPromise ??= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = config.autofirmaScriptUrl;
      script.onload = resolve;
      script.onerror = () => {
        scriptPromise = undefined;
        script.remove();
        reject(
          new Error("No se pudo cargar la biblioteca oficial de AutoFirma."),
        );
      };
      document.head.append(script);
    });
    await scriptPromise;
  }
  const client = window.AutoScript || window.MiniApplet || window.AutoFirma;
  const required = [
    "createBatch",
    "addDocumentToBatch",
    "setLocalBatchProcess",
    "signBatchProcess",
  ];
  if (
    !client ||
    required.some((method) => typeof client[method] !== "function")
  ) {
    throw new Error(
      "Biblioteca oficial de AutoFirma ausente o sin soporte de lote local.",
    );
  }
  if (!initializedClients.has(client)) {
    // clientAddress es el despliegue de AutoFirma, no la URL de nuestra API Express.
    client.cargarAppAfirma?.(config.clientAddress || null);
    // Solo configurar estos servlets si se usa un servidor intermedio real de @firma.
    if (config.storageServlet && config.retrieverServlet) {
      client.setServlets?.(config.storageServlet, config.retrieverServlet);
    }
    initializedClients.add(client);
  }
  return client;
}

export async function signHashes(documents) {
  if (signing) throw new Error("Ya hay un lote de AutoFirma en curso.");
  signing = true;
  let client;
  try {
    client = await getClient();
    client.setLocalBatchProcess(true);
    // precalculatedHashAlgorithm evita SHA256(hash): el CMS debe contener el hash del PDF.
    // El lote local selecciona una unica clave para todas sus firmas.
    client.createBatch(
      "SHA256withRSA",
      "CAdES",
      "sign",
      "precalculatedHashAlgorithm=SHA-256\nmode=explicit\nprofile=baseline\nincludeSigningTimeAttribute=false\nincludeContentHintAttribute=false",
    );
    for (const document of documents)
      client.addDocumentToBatch(document.documentId, document.hashBase64);
    const result = await new Promise((resolve, reject) => {
      client.signBatchProcess(
        false,
        null,
        null,
        "",
        resolve,
        (type, message, code) => {
          const cancelled = /cancel/i.test(type || "") || code === "AS500001";
          const error = new Error(
            cancelled
              ? "Firma cancelada por el usuario."
              : message || "No se pudo conectar con AutoFirma.",
          );
          error.name = cancelled ? "AbortError" : "AutoFirmaError";
          reject(error);
        },
      );
    });
    return normalizeBatchResult(result, documents);
  } finally {
    try {
      client?.setLocalBatchProcess(false);
    } finally {
      signing = false;
    }
  }
}
