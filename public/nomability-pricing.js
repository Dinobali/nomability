(() => {
  const planButtons = Array.from(document.querySelectorAll('[data-plan]'));

  planButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const plan = button.getAttribute('data-plan') || 'starter';
      window.location.href = `payment-method.html?plan=${encodeURIComponent(plan)}`;
    });
  });
})();
