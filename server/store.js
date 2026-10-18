import { randomUUID } from "node:crypto";

export class DocumentStore {
  constructor({ ttlMs = 15 * 60 * 1000, maxBytes = 128 * 1024 * 1024 } = {}) {
    this.documents = new Map();
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.timer = setInterval(() => this.sweep(), Math.min(ttlMs, 60000));
    this.timer.unref();
  }

  sweep() {
    for (const [id, document] of this.documents) {
      if (Date.now() >= document.expiresAt) this.delete(id);
    }
  }

  addBatch(documents) {
    this.sweep();
    const total = documents.reduce(
      (size, document) => size + document.buffer.length,
      0,
    );
    if (this.bytes + total > this.maxBytes) {
      const error = new Error("Almacen temporal lleno. Intentalo mas tarde.");
      error.status = 503;
      throw error;
    }
    return documents.map((document) => {
      const documentId = randomUUID();
      const expiresAt = Date.now() + this.ttlMs;
      this.documents.set(documentId, { ...document, expiresAt, busy: false });
      this.bytes += document.buffer.length;
      return {
        documentId,
        filename: document.filename,
        hashBase64: document.hashBase64,
        expiresAt,
      };
    });
  }

  get(id) {
    this.sweep();
    return this.documents.get(id);
  }

  delete(id) {
    const document = this.documents.get(id);
    if (document) this.bytes -= document.buffer.length;
    this.documents.delete(id);
  }

  close() {
    clearInterval(this.timer);
    this.documents.clear();
    this.bytes = 0;
  }
}
