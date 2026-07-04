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
