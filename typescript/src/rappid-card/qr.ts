import QRCode from 'qrcode';

import { parseDeepLink } from './contract.js';

export async function renderRappidCardQrSvg(deepLink: string): Promise<string> {
  const exact = parseDeepLink(deepLink).deepLink;
  return QRCode.toString(exact, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
  });
}

export async function renderRappidCardQrPng(deepLink: string): Promise<Buffer> {
  const exact = parseDeepLink(deepLink).deepLink;
  return QRCode.toBuffer(exact, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 512,
  });
}
