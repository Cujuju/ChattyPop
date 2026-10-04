document.getElementById('retry').addEventListener('click', () => {
  window.webkit.messageHandlers.shellRetry.postMessage(null);
});
