import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, Check, CheckCheck, FileText, FolderOpen,
  LoaderCircle, Plus, ShieldCheck, Signature, Trash2, Upload, X, CircleAlert } from 'lucide-react';
import JSZip from 'jszip';
import { withSigningCertificate } from './autofirma.js';
import './styles.css';

const MAX_FILES = 50;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const sizeLabel = size => size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;

async function apiResponse(response) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Error HTTP ${response.status}`);
  }
  return response;
}

function download(url, filename) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export default function BatchSigner() {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState('');
  const [previewId, setPreviewId] = useState(null);
  const [visibleSignature, setVisibleSignature] = useState(true);
  const [useExistingSignatureBox, setUseExistingSignatureBox] = useState(true);
  const [signaturePage, setSignaturePage] = useState('last');
  const [signaturePosition, setSignaturePosition] = useState('bottom-right');
  const fileInput = useRef(null);
  const folderInput = useRef(null);
  const busyRef = useRef(false);
  const urls = useRef(new Set());
  const alive = useRef(true);
  const controller = useRef(null);
  const completed = items.filter(item => item.status === 'Finalizado');
  const preview = items.find(item => item.id === previewId) || items[0];

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    };
  }, []);

  function objectUrl(blob) {
    const url = URL.createObjectURL(blob);
    urls.current.add(url);
    return url;
  }

  function patchItem(id, update) {
    if (alive.current) setItems(current => current.map(item => item.id === id ? { ...item, ...update } : item));
  }

  function addFiles(files) {
    if (busyRef.current) return;
    const candidates = Array.from(files).filter(file => /\.pdf$/i.test(file.name));
    const valid = candidates.filter(file => file.size > 0 && file.size <= MAX_FILE_BYTES);
    const seen = new Set(items.map(item => `${item.file.webkitRelativePath || item.file.name}:${item.file.size}:${item.file.lastModified}`));
    const additions = [];
    for (const file of valid) {
      const key = `${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`;
      if (seen.has(key)) continue;
      seen.add(key);
      additions.push({ id: crypto.randomUUID(), file, status: 'Pendiente', sourceUrl: objectUrl(file) });
    }
    const accepted = additions.slice(0, Math.max(0, MAX_FILES - items.length));
    for (const item of additions.slice(accepted.length)) {
      URL.revokeObjectURL(item.sourceUrl);
      urls.current.delete(item.sourceUrl);
    }
    setItems(current => [...current, ...accepted]);
    setNotice(valid.length !== Array.from(files).length ? 'Solo se admiten PDFs de hasta 10 MB, no vacios.' :
      accepted.length < additions.length ? 'El lote admite hasta 50 documentos.' : '');
  }

  function removeItem(id) {
    if (busyRef.current) return;
    const item = items.find(entry => entry.id === id);
    for (const url of [item?.sourceUrl, item?.signedUrl].filter(Boolean)) {
      URL.revokeObjectURL(url);
      urls.current.delete(url);
    }
    setItems(current => current.filter(entry => entry.id !== id));
  }

  async function signDocuments() {
    if (busyRef.current) return;
    const pending = items.filter(item => item.status !== 'Finalizado');
    if (!pending.length) return;
    busyRef.current = true;
    setBusy(true);
    setNotice('');
    controller.current = new AbortController();
    const signal = controller.current.signal;
    const prepared = [];
    for (const item of pending) patchItem(item.id, { status: 'Firmando', error: '' });
    try {
      await withSigningCertificate(async ({ certificateBase64, sign }) => {
      for (const item of pending) {
        if (!alive.current) return;
        patchItem(item.id, { status: 'Preparando', error: '' });
        try {
          const form = new FormData();
          form.append('files', item.file);
          if (visibleSignature) form.append('visibleSignature', JSON.stringify({
            certificateBase64, page: signaturePage, position: signaturePosition, useExisting: useExistingSignatureBox,
          }));
          const response = await apiResponse(await fetch('/api/pdf/prepare', { method: 'POST', body: form, signal }));
          const documents = await response.json();
          if (documents.length !== 1 || !documents[0].documentId || !documents[0].hashBase64) throw new Error('Respuesta de preparacion incorrecta.');
          prepared.push({ ...documents[0], itemId: item.id, filename: item.file.name });
        } catch (error) {
          patchItem(item.id, { status: 'Error', error: error.message });
        }
      }
      if (!prepared.length || !alive.current) return;
      for (const document of prepared) patchItem(document.itemId, { status: 'Firmando' });
      const signatures = await sign(prepared);
      for (const signature of signatures) {
        if (!alive.current) return;
        const document = prepared.find(entry => entry.documentId === signature.documentId);
        try {
          if (signature.error) throw new Error(signature.error);
          const response = await apiResponse(await fetch('/api/pdf/inject', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentId: signature.documentId, signatureBase64: signature.signatureBase64 }), signal,
          }));
          if (!response.headers.get('content-type')?.includes('application/pdf')) throw new Error('El servidor no devolvio un PDF.');
          const blob = await response.blob();
          if (!alive.current) return;
          patchItem(document.itemId, { status: 'Finalizado', signedBlob: blob, signedUrl: objectUrl(blob),
            signedName: `${document.filename.replace(/\.pdf$/i, '')}-firmado.pdf` });
        } catch (error) {
          patchItem(document.itemId, { status: 'Error', error: error.message });
        }
      }
      });
    } catch (error) {
      const affected = prepared.length ? prepared.map(document => document.itemId) : pending.map(item => item.id);
      for (const id of affected) patchItem(id, { status: 'Error', error: error.message });
      if (alive.current) setNotice(error.message);
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function downloadZip() {
    if (zipping || !completed.length) return;
    setZipping(true);
    try {
      const zip = new JSZip();
      completed.forEach((item, index) => zip.file(`${String(index + 1).padStart(2, '0')}-${item.signedName}`, item.signedBlob));
      const blob = await zip.generateAsync({ type: 'blob' });
      if (!alive.current) return;
      const url = objectUrl(blob);
      download(url, 'documentos-firmados.zip');
      setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 30000);
    } catch (error) { if (alive.current) setNotice(error.message); }
    finally { if (alive.current) setZipping(false); }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="Pliego, inicio"><span className="brand-symbol"><Signature size={23} /></span>pliego<span className="brand-dot">.</span></a>
        <span className="header-section">Documentos</span>
        <span className="private-label"><ShieldCheck size={16} /> Firma local</span>
      </header>
      <main>
        <div className="page-heading"><div><p className="eyebrow">ESPACIO DE FIRMA / NUEVO LOTE</p><h1>Firma de documentos</h1></div>
          <div className="batch-marker"><span className="live-dot" /> Lote actual</div>
        </div>
        <div className="workspace">
          <section className="documents-section" aria-label="Documentos del lote">
            <div className="section-heading"><h2>Documentos <span className="count">{items.length}</span></h2><span className="limit">PDF / 10 MB por archivo</span></div>
            <div className={`drop-area ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }}
              onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}>
              <div className="upload-mark"><Upload size={25} strokeWidth={1.5} /></div>
              <div className="upload-actions"><button disabled={busy} className="primary subtle" onClick={() => fileInput.current.click()}><Plus size={17} /> Anadir documentos</button>
                <button disabled={busy} className="text-button" onClick={() => folderInput.current.click()}><FolderOpen size={17} /> Seleccionar carpeta</button></div>
              <input ref={fileInput} aria-label="Seleccionar PDFs" type="file" accept="application/pdf,.pdf" multiple hidden onChange={event => { addFiles(event.target.files); event.target.value = ''; }} />
              <input ref={folderInput} aria-label="Seleccionar carpeta" type="file" accept="application/pdf,.pdf" webkitdirectory="" multiple hidden onChange={event => { addFiles(event.target.files); event.target.value = ''; }} />
            </div>
            {notice && <div className="notice" role="alert"><CircleAlert size={17} /><span>{notice}</span><button className="icon-button" title="Cerrar aviso" aria-label="Cerrar aviso" onClick={() => setNotice('')}><X size={16} /></button></div>}
            <div className="list-head"><span>ARCHIVO</span><span>ESTADO</span><span /></div>
            {items.length === 0 ? <div className="empty-state"><FileText size={35} strokeWidth={1} /><p>Sin documentos</p><span>00 / 50</span></div> :
              <ul className="file-list">{items.map(item => <li key={item.id} className={preview?.id === item.id ? 'selected' : ''}>
                <button className="file-name-button" onClick={() => setPreviewId(item.id)} title={item.file.name}><span className="pdf-icon"><FileText size={21} /><small>PDF</small></span><span className="file-meta"><strong>{item.file.name}</strong><small>{sizeLabel(item.file.size)}</small>{item.error && <span className="file-error">{item.error}</span>}</span></button>
                <span className={`status status-${item.status.toLowerCase()}`}>{item.status === 'Finalizado' ? <Check size={13} /> : ['Preparando', 'Firmando'].includes(item.status) ? <LoaderCircle className="spin" size={13} /> : item.status === 'Error' ? <CircleAlert size={13} /> : <span className="status-dot" />}{item.status}</span>
                {item.signedUrl ? <button className="icon-button" title="Descargar PDF firmado" aria-label={`Descargar ${item.file.name}`} onClick={() => download(item.signedUrl, item.signedName)}><ArrowDownToLine size={17} /></button> : <button className="icon-button" disabled={busy} title="Eliminar documento" aria-label={`Eliminar ${item.file.name}`} onClick={() => removeItem(item.id)}><Trash2 size={16} /></button>}
              </li>)}</ul>}
            <div className="list-footer"><span>{items.length} {items.length === 1 ? 'documento' : 'documentos'}</span><span>{sizeLabel(items.reduce((total, item) => total + item.file.size, 0))} en total</span></div>
          </section>
          <aside className="summary-section">
            <h2>Resumen del lote</h2>
            <div className="summary-number">{String(items.length).padStart(2, '0')}<span>documentos</span></div>
            <dl className="summary-details"><div><dt>Formato</dt><dd>PDF / PAdES</dd></div><div><dt>Certificado</dt><dd>AutoFirma <ArrowUpRight size={12} /></dd></div><div><dt>Algoritmo</dt><dd>SHA-256</dd></div></dl>
            <form id="signature-settings" className="signature-settings" aria-label="Apariencia de la firma" onSubmit={event => { event.preventDefault(); signDocuments(); }}>
              <label className="signature-toggle"><input type="checkbox" checked={visibleSignature} disabled={busy} onChange={event => setVisibleSignature(event.target.checked)} /><span>Firma visible</span></label>
              <fieldset disabled={busy || !visibleSignature} className="signature-fields">
                <label className="signature-existing"><input type="checkbox" checked={useExistingSignatureBox} onChange={event => setUseExistingSignatureBox(event.target.checked)} /><span>Usar casilla del PDF</span></label>
                <label htmlFor="signature-page">Pagina alternativa<select id="signature-page" disabled={useExistingSignatureBox} value={signaturePage} onChange={event => setSignaturePage(event.target.value)}><option value="last">Ultima pagina</option><option value="first">Primera pagina</option></select></label>
                <label htmlFor="signature-position">Posicion alternativa<select id="signature-position" disabled={useExistingSignatureBox} value={signaturePosition} onChange={event => setSignaturePosition(event.target.value)}><option value="bottom-right">Abajo, derecha</option><option value="bottom-left">Abajo, izquierda</option><option value="top-right">Arriba, derecha</option><option value="top-left">Arriba, izquierda</option></select></label>
              </fieldset>
              {visibleSignature && <div className="signature-box-preview" aria-label="Aspecto de la firma visible"><strong>FIRMA ELECTRONICA</strong><span>DNI/NIE: Certificado de AutoFirma</span><span>Fecha: Automatica (UTC)</span></div>}
            </form>
            <div className="completion"><div><span>Finalizados</span><strong aria-live="polite">{completed.length} / {items.length}</strong></div><progress aria-label="Documentos finalizados" value={completed.length} max={items.length || 1} /></div>
            <button type="submit" form="signature-settings" className="primary sign-button" disabled={busy || !items.length || completed.length === items.length}>{busy ? <LoaderCircle className="spin" size={18} /> : <Signature size={18} />}{busy ? 'Firma en curso' : 'Firmar Documentos'}</button>
            <button className="secondary" disabled={!completed.length || zipping} onClick={downloadZip}>{zipping ? <LoaderCircle className="spin" size={17} /> : <ArrowDownToLine size={17} />} Descargar firmados <span className="zip-label">ZIP</span></button>
            <div className="security-note"><ShieldCheck size={17} /><span>Clave privada en tu dispositivo</span></div>
            <div className="batch-seal"><CheckCheck size={22} strokeWidth={1.3} /><span>PLIEGO<span>DOCUMENTOS DIGITALES</span></span></div>
          </aside>
        </div>
        {preview && <section className="preview-section"><div className="section-heading"><h2>Vista previa</h2><span className="preview-name">{preview.file.name}</span></div><iframe title={`Vista previa de ${preview.file.name}`} src={`${preview.signedUrl || preview.sourceUrl}#toolbar=0`} /></section>}
        <footer><span>Pliego / Documentos digitales</span><span><ShieldCheck size={13} /> Conexion directa con AutoFirma</span></footer>
      </main>
    </div>
  );
}