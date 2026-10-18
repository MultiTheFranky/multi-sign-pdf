import { preparePdf, injectPdf } from "../pdf.js";
import { decodeSignature, verifyCms } from "../cms.js";

export function pdfController(store) {
  return {
    async prepare(request, response) {
      if (!request.files?.length)
        return response
          .status(400)
          .json({ error: "Adjunta PDFs en el campo files." });
      const documents = [];
      try {
        for (const file of request.files) {
          const prepared = await preparePdf(file.buffer);
          documents.push({
            ...prepared,
            filename: file.originalname.replace(/[\r\n]/g, ""),
          });
        }
      } catch (error) {
        return response
          .status(422)
          .json({ error: `No se pudo preparar el lote: ${error.message}` });
      }
      response.status(201).json(store.addBatch(documents));
    },

    async inject(request, response) {
      const { documentId, signatureBase64 } = request.body ?? {};
      if (
        typeof documentId !== "string" ||
        !/^[0-9a-f-]{36}$/.test(documentId)
      ) {
        return response.status(400).json({ error: "documentId invalido." });
      }
      const document = store.get(documentId);
      if (!document)
        return response
          .status(404)
          .json({ error: "Documento inexistente, consumido o caducado." });
      if (document.busy)
        return response
          .status(409)
          .json({ error: "La firma ya esta siendo verificada." });
      document.busy = true;
      try {
        const signature = decodeSignature(signatureBase64);
        await verifyCms(signature, document);
        const result = injectPdf(document, signature);
        const filename = `${document.filename.replace(/\.pdf$/i, "")}-firmado.pdf`;
        response.type("application/pdf").attachment(filename).send(result);
        store.delete(documentId);
      } catch (error) {
        response.status(422).json({ error: error.message });
      } finally {
        document.busy = false;
      }
    },
  };
}
