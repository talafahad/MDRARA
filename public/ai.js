'use strict';
// Midrar AI slot.
// When you finish your model, export it from Teachable Machine as "Tensorflow.js" and copy the
// three files (model.json, metadata.json, weights.bin) into  public/model/  - nothing else to change.
// The photo is analysed in the browser and never uploaded: only the chosen items and the weight are sent.
(function () {
  const TF = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@1.3.1/dist/tf.min.js';
  const TM = 'https://cdn.jsdelivr.net/npm/@teachablemachine/image@0.8/dist/teachablemachine-image.min.js';
  let modelPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('script_failed'));
      document.head.appendChild(s);
    });
  }
  function load() {
    if (!modelPromise) {
      modelPromise = (async () => {
        await loadScript(TF);
        await loadScript(TM);
        return window.tmImage.load('/model/model.json', '/model/metadata.json');
      })().catch((e) => { modelPromise = null; throw e; });
    }
    return modelPromise;
  }
  // Returns [{label, p}] sorted by probability, highest first.
  async function classify(imgEl) {
    const model = await load();
    const preds = await model.predict(imgEl);
    return preds.map((p) => ({ label: p.className, p: p.probability })).sort((a, b) => b.p - a.p);
  }
  // Match a model label to one of the organisation's items (ai_label first, then English, then Arabic name).
  function matchItem(label, items) {
    const n = String(label).trim().toLowerCase();
    return items.find((i) => i.active && [i.ai_label, i.name_en, i.name_ar].some((x) => x && String(x).trim().toLowerCase() === n)) || null;
  }
  window.MidrarAI = { classify, matchItem, load };
})();
