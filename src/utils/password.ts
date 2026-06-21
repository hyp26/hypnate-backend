const validatePassword = (password: string) =>
  /^(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*]).{8,}$/.test(password);

export { validatePassword };