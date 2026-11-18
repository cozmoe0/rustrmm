;(function () {
  try {
    var stored = localStorage.getItem('rustrmm.theme')
    var dark =
      stored === 'dark' ||
      (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    var root = document.documentElement
    root.classList.toggle('dark', dark)
    root.style.colorScheme = dark ? 'dark' : 'light'
    var density = localStorage.getItem('rustrmm.density')
    if (density === 'comfortable') root.dataset.density = 'comfortable'
  } catch (e) {
    document.documentElement.classList.add('dark')
  }
})()
