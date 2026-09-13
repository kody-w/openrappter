import { isAppDocument } from "./contract.js";

type Contents = { mainFrame: { url: string } };
type Details = {
  isMainFrame: boolean;
  requestingUrl?: string;
  mediaType?: string;
  mediaTypes?: readonly string[];
};
export function allowsMicrophone(
  contents: unknown, owned: Contents | null, permission: string, details: Details, foreground: boolean,
): boolean {
  return foreground && owned !== null && contents === owned && permission === "media"
    && details.isMainFrame === true && isAppDocument(owned.mainFrame.url)
    && typeof details.requestingUrl === "string" && isAppDocument(details.requestingUrl)
    && (details.mediaTypes !== undefined
      ? details.mediaTypes.length === 1 && details.mediaTypes[0] === "audio"
      : details.mediaType === "audio");
}
