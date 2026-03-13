export function isStrongEnoughPassword(value: string) {
  if (value.length < 10 || value.length > 200) return false;
  const hasLetter = /[A-Za-z]/.test(value);
  const hasNumber = /\d/.test(value);
  return hasLetter && hasNumber;
}

