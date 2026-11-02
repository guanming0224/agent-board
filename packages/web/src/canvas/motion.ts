/** 鏡頭移動的時間；使用者要求減少動態時直接到位。 */
export const motion = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200);
