import { onBeforeUnmount, onMounted } from 'vue'

export function useSuppressNativeTitles() {
  const suppressed = new Map<Element, () => void>()

  function suppress(element: Element, originalTitle: string) {
    let title: string | null = originalTitle
    element.removeAttribute('title')

    // Vue can update a dynamic title while the pointer is still over the element.
    const observer = new MutationObserver(() => {
      title = element.getAttribute('title')
      if (title === null) return
      element.removeAttribute('title')
      observer.takeRecords()
    })
    observer.observe(element, { attributes: true, attributeFilter: ['title'] })

    suppressed.set(element, () => {
      if (observer.takeRecords().length) title = element.getAttribute('title')
      observer.disconnect()
      if (title !== null) element.setAttribute('title', title)
      suppressed.delete(element)
    })
  }

  function restoreOutside(target: EventTarget | null) {
    for (const [element, restore] of suppressed) {
      if (!(target instanceof Node) || !element.contains(target)) restore()
    }
  }

  function handleMouseOver(event: MouseEvent) {
    restoreOutside(event.target)
    // A descendant can inherit a title from any ancestor under the pointer.
    for (
      let element = event.target instanceof Element ? event.target : null;
      element;
      element = element.parentElement
    ) {
      if (suppressed.has(element)) continue
      const title = element.getAttribute('title')
      if (title) suppress(element, title)
    }
  }

  function handleMouseOut(event: MouseEvent) {
    restoreOutside(event.relatedTarget)
  }

  onMounted(() => {
    document.addEventListener('mouseover', handleMouseOver, true)
    document.addEventListener('mouseout', handleMouseOut, true)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('mouseover', handleMouseOver, true)
    document.removeEventListener('mouseout', handleMouseOut, true)
    restoreOutside(null)
  })
}
