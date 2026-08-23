// fflate is used only by the egg packer in rapp-protocol.mjs. The drill path
// never touches it, so rather than shipping a zip implementation this refuses
// clearly if something reaches for it — a stub that returns plausible nonsense
// would be worse than one that says it is not here.
const absent = (name) => () => {
  throw new Error(`${name} is not available on this page — eggs are packed by the app, not the browser`);
};
export const zipSync = absent("zipSync");
export const unzipSync = absent("unzipSync");
export const strToU8 = absent("strToU8");
export const strFromU8 = absent("strFromU8");
export default { zipSync, unzipSync, strToU8, strFromU8 };
