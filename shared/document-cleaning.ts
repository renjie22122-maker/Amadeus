export type CleaningOptions = {
  trailingSpaces?: boolean;
  blankLines?: boolean;
  controlCharacters?: boolean;
};
/** Opt-in textual cleanup. Never guesses OCR corrections or removes repeated paragraphs. */
export function cleanDocumentText(text: string, options: CleaningOptions): string {
  let result = text;
  if (options.controlCharacters)
    result = result.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (options.trailingSpaces) result = result.replace(/[ \t]+(?=\r?$)/gm, '');
  if (options.blankLines) result = result.replace(/(\r?\n)(?:[ \t]*\r?\n){2,}/g, '$1$1');
  return result;
}
