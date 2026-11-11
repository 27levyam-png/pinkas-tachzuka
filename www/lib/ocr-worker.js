/* זיהוי טקסט בתוך המכשיר (Tesseract). התמונות לא יוצאות מהמכשיר. */
var api = null, M = null;
self.onmessage = async function (e) {
  var m = e.data;
  try {
    if (m.cmd === 'init') {
      if (!api) {
        importScripts(m.core);
        M = await TesseractCore({});
        M.FS.writeFile('/heb.traineddata', new Uint8Array(m.data));
        api = new M.TessBaseAPI();
        var rc = api.Init(null, 'heb');
        if (rc !== 0) throw new Error('init failed ' + rc);
        api.SetVariable('tessedit_pageseg_mode', '4');
        api.SetVariable('preserve_interword_spaces', '1');
      }
      postMessage({ id: m.id, ok: true });
      return;
    }
    if (m.cmd === 'ocr') {
      M.FS.writeFile('/input', new Uint8Array(m.img));
      if (api.SetImageFile(1, 0) === 1) throw new Error('לא ניתן לקרוא את התמונה');
      api.Recognize(null);
      var text = api.GetUTF8Text();
      api.Clear();
      postMessage({ id: m.id, ok: true, text: text });
    }
  } catch (err) {
    postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
  }
};
