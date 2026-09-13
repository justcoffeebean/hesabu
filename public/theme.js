/* Applies the saved appearance before first paint, so dark mode never flashes white. */
(function () {
  try {
    var theme = localStorage.getItem('hesabu-theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  } catch (e) { /* private mode: fall back to the device setting */ }
})();
