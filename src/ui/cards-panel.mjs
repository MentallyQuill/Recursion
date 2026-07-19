export function cardsPanelState(viewModel = {}) {
  const cards = Array.isArray(viewModel.cards)
    ? viewModel.cards
    : (Array.isArray(viewModel.lastHand?.cards) ? viewModel.lastHand.cards : []);
  return {
    count: cards.length,
    cards,
    empty: cards.length === 0
  };
}

function appendChildren(node, children = []) {
  for (const child of children) {
    if (child !== null && child !== undefined) node.appendChild(child);
  }
  return node;
}

function requireElementFactory(options = {}) {
  if (typeof options.el !== 'function') throw new TypeError('Deck panel rendering requires an element factory.');
  return options.el;
}

export function renderDeckBar(options = {}) {
  const el = requireElementFactory(options);
  const {
    className = 'recursion-deck-bar',
    title = '',
    summary = '',
    selector = null,
    actions = [],
    dataset = {}
  } = options;
  return el('header', { className, dataset }, [
    el('span', { className: 'recursion-dropdown-title', text: title }),
    summary ? el('span', { className: 'recursion-deck-summary', text: summary }) : null,
    selector,
    ...actions
  ].filter(Boolean));
}

export function renderDeckCategory(options = {}) {
  const el = requireElementFactory(options);
  const {
    className = 'recursion-deck-category',
    category,
    header = [],
    body = [],
    expanded = true,
    dataset = {}
  } = options;
  const shell = el('section', {
    className,
    attrs: {
      'data-category-id': String(category?.id || ''),
      'aria-label': String(category?.name || 'Card category')
    },
    dataset
  });
  appendChildren(shell, [
    el('div', {
      className: `${className}-head`,
      attrs: { 'aria-expanded': expanded ? 'true' : 'false' }
    }, header),
    el('div', {
      className: `${className}-body`,
      attrs: expanded ? {} : { hidden: '' }
    }, body)
  ]);
  return shell;
}

export function renderDeckCard(options = {}) {
  const el = requireElementFactory(options);
  const {
    className = 'recursion-deck-card',
    card,
    children = [],
    dataset = {}
  } = options;
  return el('div', {
    className,
    attrs: { 'data-card-id': String(card?.id || '') },
    dataset
  }, children);
}

export function createDeckDragController({
  onCategoryMove = () => {},
  onCardMove = () => {},
  holdMs = 180,
  edgePx = 32,
  scrollStep = 14,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
  requestFrame = (callback) => typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(callback)
    : setTimeout(callback, 16),
  cancelFrame = (frame) => typeof cancelAnimationFrame === 'function'
    ? cancelAnimationFrame(frame)
    : clearTimeout(frame)
} = {}) {
  let active = null;
  let holdTimer = null;
  let edgeScrollFrame = null;
  let edgeScrollHost = null;
  let edgeScrollDirection = 0;
  let destroyed = false;

  function stopEdgeScroll() {
    if (edgeScrollFrame !== null) cancelFrame(edgeScrollFrame);
    edgeScrollFrame = null;
    edgeScrollHost = null;
    edgeScrollDirection = 0;
  }

  function clear() {
    if (holdTimer !== null) clearTimer(holdTimer);
    holdTimer = null;
    stopEdgeScroll();
    active = null;
  }

  function begin(detail = {}, { touch = false } = {}) {
    if (destroyed) return false;
    clear();
    if (!touch) {
      active = detail;
      return true;
    }
    holdTimer = setTimer(() => {
      active = detail;
      holdTimer = null;
    }, Math.max(0, Number(holdMs) || 0));
    return true;
  }

  function scheduleEdgeScroll() {
    if (!active || !edgeScrollHost || edgeScrollDirection === 0 || edgeScrollFrame !== null) return;
    edgeScrollFrame = requestFrame(() => {
      edgeScrollFrame = null;
      if (!active || !edgeScrollHost || edgeScrollDirection === 0) return;
      edgeScrollHost.scrollTop = Math.max(
        0,
        Number(edgeScrollHost.scrollTop || 0) + (edgeScrollDirection * Math.max(1, Number(scrollStep) || 1))
      );
      scheduleEdgeScroll();
    });
  }

  function setEdgeScroll({ host = null, clientY = 0 } = {}) {
    if (!active || !host) {
      stopEdgeScroll();
      return false;
    }
    const rect = host.getBoundingClientRect?.();
    const pointerY = Number(clientY);
    const threshold = Math.max(0, Number(edgePx) || 0);
    const direction = rect && pointerY < Number(rect.top) + threshold
      ? -1
      : rect && pointerY > Number(rect.bottom) - threshold
        ? 1
        : 0;
    if (direction === 0) {
      stopEdgeScroll();
      return false;
    }
    if (edgeScrollHost !== host || edgeScrollDirection !== direction) stopEdgeScroll();
    edgeScrollHost = host;
    edgeScrollDirection = direction;
    scheduleEdgeScroll();
    return true;
  }

  function drop(target = {}) {
    if (!active) return false;
    const source = active;
    clear();
    if (source.kind === 'category') {
      onCategoryMove(source.id, target.beforeId || '');
      return true;
    }
    if (source.kind === 'card') {
      onCardMove(source.id, target.categoryId || source.categoryId, target.beforeId || '');
      return true;
    }
    return false;
  }

  function destroy() {
    clear();
    destroyed = true;
  }

  return {
    begin,
    cancel: clear,
    drop,
    active: () => active,
    setEdgeScroll,
    stopEdgeScroll,
    destroy
  };
}
