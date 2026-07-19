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
  holdMs = 180
} = {}) {
  let active = null;
  let holdTimer = null;

  function clear() {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
    active = null;
  }

  function begin(detail = {}, { touch = false } = {}) {
    clear();
    if (!touch) {
      active = detail;
      return;
    }
    holdTimer = setTimeout(() => {
      active = detail;
      holdTimer = null;
    }, Math.max(0, Number(holdMs) || 0));
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

  return {
    begin,
    cancel: clear,
    drop,
    active: () => active
  };
}
