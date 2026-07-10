export const ENHANCEMENT_EDIT_RATIO_MINIMUM = 0.1;
export const ENHANCEMENT_EDIT_RATIO_TARGET_MIN = 0.1;
export const ENHANCEMENT_EDIT_RATIO_TARGET_MAX = 0.2;
export const ENHANCEMENT_EDIT_RATIO_SOFT_MAX = 0.3;

export function editDistance(leftValue = '', rightValue = '') {
  const left = String(leftValue ?? '');
  const right = String(rightValue ?? '');
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = new Array(right.length + 1).fill(0);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + cost
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length];
}

export function enhancementEditRatio(originalText = '', enhancedText = '') {
  const source = String(originalText ?? '');
  if (!source.length) return String(enhancedText ?? '').length ? 1 : 0;
  return editDistance(source, String(enhancedText ?? '')) / source.length;
}

export function roundedEnhancementEditRatio(originalText = '', enhancedText = '') {
  return Number(enhancementEditRatio(originalText, enhancedText).toFixed(4));
}
