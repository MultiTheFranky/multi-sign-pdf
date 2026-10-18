import { PDFDocument, PDFName, StandardFonts, rgb } from "pdf-lib";
import { signingIdentity } from "./certificate.js";

export function validateVisibleSignature(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("visibleSignature debe ser un objeto.");
  }
  const identity = signingIdentity(value.certificateBase64);
  const page = value.page ?? "last";
  const position = value.position ?? "bottom-right";
  if (
    !["first", "last"].includes(page) ||
    !["bottom-right", "bottom-left", "top-right", "top-left"].includes(position)
  ) {
    throw new Error("Pagina o posicion de firma visible no valida.");
  }
  if (
    value.useExisting !== undefined &&
    typeof value.useExisting !== "boolean"
  ) {
    throw new Error("useExisting debe ser un booleano.");
  }
  return {
    ...identity,
    certificateBase64: value.certificateBase64,
    page,
    position,
    useExisting: value.useExisting ?? true,
  };
}

export async function createSignatureAppearance(
  pdf,
  options,
  signingTime,
  target,
) {
  const page =
    target?.page ??
    (options.page === "first" ? pdf.getPages()[0] : pdf.getPages().at(-1));
  const crop = page.getCropBox();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(rotation))
    throw new Error("Rotacion de pagina no compatible.");
  const viewWidth = rotation % 180 ? crop.height : crop.width;
  const viewHeight = rotation % 180 ? crop.width : crop.height;
  const margin = Math.min(24, viewWidth * 0.08, viewHeight * 0.08);
  const targetWidth = target ? target.rect[2] - target.rect[0] : undefined;
  const targetHeight = target ? target.rect[3] - target.rect[1] : undefined;
  const width = target
    ? rotation % 180
      ? targetHeight
      : targetWidth
    : Math.min(250, viewWidth - margin * 2);
  const height = target
    ? rotation % 180
      ? targetWidth
      : targetHeight
    : Math.min(76, viewHeight - margin * 2);
  if (!target && (width < 150 || height < 60))
    throw new Error("La pagina es demasiado pequena para la firma visible.");
  const left = options.position.endsWith("right")
    ? viewWidth - margin - width
    : margin;
  const bottom = options.position.startsWith("top")
    ? viewHeight - margin - height
    : margin;
  const rectangles = {
    0: [left, bottom, left + width, bottom + height],
    90: [crop.width - bottom - height, left, crop.width - bottom, left + width],
    180: [
      crop.width - left - width,
      crop.height - bottom - height,
      crop.width - left,
      crop.height - bottom,
    ],
    270: [
      bottom,
      crop.height - left - width,
      bottom + height,
      crop.height - left,
    ],
  };
  const rect =
    target?.rect ??
    rectangles[rotation].map(
      (coordinate, index) => coordinate + (index % 2 ? crop.y : crop.x),
    );
  const stamp = await PDFDocument.create();
  const stampPage = stamp.addPage([width, height]);
  const font = await stamp.embedFont(StandardFonts.Helvetica);
  const bold = await stamp.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.09, 0.38, 0.28);
  stampPage.drawRectangle({
    x: 0.5,
    y: 0.5,
    width: width - 1,
    height: height - 1,
    borderWidth: 1,
    borderColor: ink,
    color: rgb(0.97, 0.99, 0.98),
  });
  const scale = Math.min(1, width / 250, height / 76);
  const lines = [
    {
      text: "FIRMA ELECTRONICA",
      font: bold,
      size: 9 * scale,
      y: height - 19 * scale,
    },
    {
      text: `DNI/NIE: ${options.dni}`,
      font: bold,
      size: 11 * scale,
      y: height - 38 * scale,
    },
    {
      text: `Fecha: ${signingTime.toISOString().slice(0, 19).replace("T", " ")} UTC`,
      font,
      size: 9 * scale,
      y: height - 56 * scale,
    },
  ];
  for (const line of lines) {
    const size = Math.min(
      line.size,
      (width - 24 * scale) / line.font.widthOfTextAtSize(line.text, 1),
    );
    stampPage.drawText(line.text, {
      x: 12 * scale,
      y: line.y,
      size,
      font: line.font,
      color: ink,
    });
  }
  const [appearance] = await pdf.embedPdf(await stamp.save());
  await appearance.embed();
  const matrices = {
    0: [1, 0, 0, 1, 0, 0],
    90: [0, 1, -1, 0, height, 0],
    180: [-1, 0, 0, -1, width, height],
    270: [0, -1, 1, 0, 0, width],
  };
  pdf.context
    .lookup(appearance.ref)
    .dict.set(PDFName.of("Matrix"), pdf.context.obj(matrices[rotation]));
  return { page, rect, appearanceRef: appearance.ref };
}
