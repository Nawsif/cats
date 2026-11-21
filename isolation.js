window.catsIsolationReady = (async () => {
  if (crossOriginIsolated) return;
  if (!isSecureContext || !('serviceWorker' in navigator))
    throw Error('Open this game through HTTPS or the included local server.');
  const workerUrl = new URL('isolation-worker.js', document.currentScript.src);
  const key = 'cats-isolation-reload:' + workerUrl.pathname;
  await navigator.serviceWorker.register(workerUrl, {scope:'./', updateViaCache:'none'});
  await navigator.serviceWorker.ready;
  if (sessionStorage.getItem(key) && navigator.serviceWorker.controller)
    throw Error('This browser could not enable the game engine. Allow service workers and reload.');
  sessionStorage.setItem(key, '1');
  if (!navigator.serviceWorker.controller)
    await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once:true}));
  location.reload();
  await new Promise(() => {});
})();
window.catsIsolationReady.catch(() => {});
