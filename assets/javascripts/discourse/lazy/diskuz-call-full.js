/**
 * Chunk lazy diskuz-call: carica glue + UI al primo click sul floating button.
 * Non viene incluso nel bundle iniziale.
 */
import { initGlue } from "../diskuz-call-glue";
import { initUI } from "../diskuz-call-ui";

export default function initDiskuzCallFull(api) {
  initGlue(api);
  initUI(api);
}
