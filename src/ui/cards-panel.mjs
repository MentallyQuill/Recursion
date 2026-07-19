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

function requireElementFactory(options = {}) {
  if (typeof options.el !== 'function') throw new TypeError('Deck panel rendering requires an element factory.');
  return options.el;
}

function classNames(...values) {
  return values
    .flatMap((value) => String(value || '').trim().split(/\s+/))
    .filter(Boolean)
    .join(' ');
}

function presentChildren(children = []) {
  return children.filter((child) => child !== null && child !== undefined);
}

export function renderDeckPanelHeader(options = {}) {
  const el = requireElementFactory(options);
  const {
    title = '',
    summary = '',
    controls = [],
    className = '',
    actionsClassName = '',
    dataset = {},
    actionsDataset = {}
  } = options;
  return el('header', {
    className: classNames('recursion-card-panel-head', className),
    dataset
  }, [
    el('span', { className: 'recursion-dropdown-title', text: title }),
    el('span', {
      className: classNames('recursion-card-panel-head-actions', actionsClassName),
      dataset: actionsDataset
    }, [
      summary
        ? el('span', { className: 'recursion-card-panel-summary', text: summary })
        : null,
      ...controls
    ].filter(Boolean))
  ]);
}

export function renderDeckToolbar(options = {}) {
  const el = requireElementFactory(options);
  const {
    selector,
    actions = [],
    className = '',
    selectorClassName = '',
    actionsClassName = '',
    dataset = {}
  } = options;
  return el('div', {
    className: classNames('recursion-card-panel-deck-bar', className),
    dataset
  }, [
    el('span', {
      className: classNames('recursion-card-panel-deck-selector', selectorClassName)
    }, [selector]),
    el('span', {
      className: classNames('recursion-card-panel-deck-actions', actionsClassName)
    }, presentChildren(actions))
  ]);
}

export function renderDeckCategory(options = {}) {
  const el = requireElementFactory(options);
  const {
    className = '',
    category = {},
    expanded = true,
    disclosure,
    copy,
    state = null,
    actions = [],
    auxiliary = [],
    body = [],
    dataset = {},
    headerDataset = {},
    actionsDataset = {},
    actionsClassName = '',
    headerClassName = '',
    bodyClassName = '',
    headerTitle = '',
    headerAriaLabel = ''
  } = options;
  const presentActions = presentChildren(actions);
  const headClassName = classNames(
    'recursion-card-panel-category-head',
    headerClassName,
    state ? 'has-state' : '',
    presentActions.length ? 'has-actions' : ''
  );
  return el('section', {
    className: classNames(
      'recursion-card-panel-category',
      expanded ? 'is-expanded' : 'is-collapsed',
      className
    ),
    attrs: {
      'data-category-id': String(category.id || ''),
      'aria-label': String(category.name || 'Card category')
    },
    dataset
  }, [
    el('div', {
      className: headClassName,
      attrs: {
        role: 'button',
        tabindex: '0',
        title: headerTitle || undefined,
        'aria-label': headerAriaLabel || String(category.name || 'Card category'),
        'aria-expanded': expanded ? 'true' : 'false'
      },
      dataset: headerDataset
    }, [
      el('span', {
        className: 'recursion-card-panel-disclosure',
        attrs: { 'aria-hidden': 'true' }
      }, [disclosure]),
      copy,
      state,
      presentActions.length
        ? el('span', {
          className: classNames('recursion-card-panel-row-actions', actionsClassName),
          dataset: actionsDataset
        }, presentActions)
        : null
    ].filter(Boolean)),
    ...presentChildren(auxiliary),
    el('div', {
      className: classNames('recursion-card-panel-category-body', bodyClassName),
      attrs: expanded ? {} : { hidden: '' }
    }, presentChildren(body))
  ]);
}

export function renderDeckCard(options = {}) {
  const el = requireElementFactory(options);
  const {
    className = '',
    card = {},
    copy,
    state,
    actions = [],
    attrs = {},
    dataset = {},
    mainAttrs = {},
    mainDataset = {},
    mainClassName = '',
    actionsClassName = ''
  } = options;
  const presentActions = presentChildren(actions);
  return el('div', {
    className: classNames(
      'recursion-card-panel-card',
      presentActions.length ? 'has-actions' : '',
      className
    ),
    attrs: {
      ...attrs,
      'data-card-id': String(card.id || '')
    },
    dataset
  }, [
    el('button', {
      className: classNames('recursion-card-panel-card-main', mainClassName),
      attrs: { type: 'button', ...mainAttrs },
      dataset: mainDataset
    }, [copy, state].filter(Boolean)),
    presentActions.length
      ? el('span', {
        className: classNames('recursion-card-panel-row-actions', actionsClassName)
      }, presentActions)
      : null
  ].filter(Boolean));
}
