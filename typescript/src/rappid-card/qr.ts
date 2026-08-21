import QRCode from 'qrcode';

import { parseCardLink } from './contract.js';

export async function renderRappidCardQrSvg(deepLink: string): Promise<string> {
  parseCardLink(deepLink);
  const exact = deepLink;
  return QRCode.toString(exact, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
  });
}

export async function renderRappidCardQrPng(deepLink: string): Promise<Buffer> {
  parseCardLink(deepLink);
  const exact = deepLink;
  return QRCode.toBuffer(exact, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 512,
  });
}
