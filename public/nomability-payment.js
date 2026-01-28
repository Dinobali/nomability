(() => {
  const statusEl = document.querySelector('[data-payment-status]');
  const bankFields = document.querySelectorAll('[data-bank-field]');
  const stripeButton = document.querySelector('[data-payment="stripe"]');
  const invoiceOpen = document.querySelector('[data-invoice-open]');
  const invoiceModal = document.querySelector('[data-invoice-modal]');
  const invoiceClose = document.querySelector('[data-invoice-close]');
  const invoiceForm = document.getElementById('invoice-form');
  const invoiceStatus = document.querySelector('[data-invoice-status]');
  const paypalLink = document.querySelector('[data-payment="paypal"]');

  const planMap = {
    starter: {
      title: 'Starter',
      subtitle: '10 hours / month',
      price: '9,99€'
    },
    pro: {
      title: 'Pro',
      subtitle: '20 hours / month',
      price: '19,99€'
    },
    unlimited: {
      title: 'Unlimited',
      subtitle: 'Unlimited hours',
      price: '34,99€'
    }
  };

  const params = new URLSearchParams(window.location.search);
  const plan = params.get('plan') || 'starter';
  const planInfo = planMap[plan] || planMap.starter;

  const planTitle = document.querySelector('[data-plan-title]');
  const planSubtitle = document.querySelector('[data-plan-subtitle]');
  const planPrice = document.querySelector('[data-plan-price]');

  if (planTitle) planTitle.textContent = planInfo.title;
  if (planSubtitle) planSubtitle.textContent = planInfo.subtitle;
  if (planPrice) planPrice.textContent = planInfo.price;

  if (paypalLink) {
    const subject = encodeURIComponent(`Nomability PayPal request - ${planInfo.title}`);
    paypalLink.href = `mailto:support@nomability.net?subject=${subject}`;
  }

  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };

  const openAuthModal = () => {
    const loginButton = document.querySelector('[data-auth-open="login"]');
    if (loginButton) {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return;
    }
    window.location.href = `login.html?redirect=payment-method.html?plan=${encodeURIComponent(plan)}`;
  };

  const requireAuth = (event) => {
    const token = localStorage.getItem('nmAuthToken');
    if (token) return;
    event.preventDefault();
    openAuthModal();
  };

  const startCheckout = async () => {
    const token = localStorage.getItem('nmAuthToken');
    if (!token) {
      openAuthModal();
      return;
    }

    setStatus('Redirecting to checkout...');
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ plan })
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        openAuthModal();
        return;
      }
      if (!response.ok) {
        setStatus(data.error || 'Unable to start checkout.');
        return;
      }
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (error) {
      setStatus('Checkout failed. Please try again.');
    }
  };

  if (stripeButton) {
    stripeButton.addEventListener('click', startCheckout);
  }

  const openInvoiceModal = () => {
    if (!invoiceModal) return;
    if (invoiceStatus) invoiceStatus.textContent = '';
    invoiceModal.hidden = false;
    invoiceModal.classList.add('is-open');
    document.body.classList.add('nm-modal-open');
  };

  const closeInvoiceModal = () => {
    if (!invoiceModal) return;
    invoiceModal.classList.remove('is-open');
    invoiceModal.hidden = true;
    document.body.classList.remove('nm-modal-open');
  };

  if (invoiceOpen) {
    invoiceOpen.addEventListener('click', (event) => {
      const token = localStorage.getItem('nmAuthToken');
      if (!token) {
        event.preventDefault();
        openAuthModal();
        return;
      }
      openInvoiceModal();
    });
  }

  if (invoiceClose) {
    invoiceClose.addEventListener('click', closeInvoiceModal);
  }

  if (invoiceModal) {
    const dialog = invoiceModal.querySelector('.nm-auth-dialog');
    if (dialog) {
      dialog.addEventListener('click', (event) => event.stopPropagation());
    }
    invoiceModal.addEventListener('click', closeInvoiceModal);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeInvoiceModal();
  });

  if (invoiceForm) {
    invoiceForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const token = localStorage.getItem('nmAuthToken');
      if (!token) {
        openAuthModal();
        return;
      }
      if (invoiceStatus) invoiceStatus.textContent = 'Creating invoice...';
      const payload = {
        plan,
        name: document.getElementById('invoice-name')?.value?.trim() || '',
        address: document.getElementById('invoice-address')?.value?.trim() || '',
        phone: document.getElementById('invoice-phone')?.value?.trim() || ''
      };
      if (!payload.name || !payload.address || !payload.phone) {
        if (invoiceStatus) invoiceStatus.textContent = 'Please fill in all invoice fields.';
        return;
      }
      try {
        const response = await fetch('/api/billing/invoice', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify(payload)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (invoiceStatus) invoiceStatus.textContent = data.error || 'Invoice request failed.';
          return;
        }
        if (invoiceStatus) invoiceStatus.textContent = 'Invoice created. Check your profile for payment instructions.';
        if (statusEl && data.invoice?.invoiceNumber) {
          statusEl.textContent = `Invoice ${data.invoice.invoiceNumber} created.`;
        }
        closeInvoiceModal();
        setTimeout(() => {
          window.location.href = 'profile.html';
        }, 800);
      } catch (error) {
        if (invoiceStatus) invoiceStatus.textContent = 'Invoice request failed. Please try again.';
      }
    });
  }

  if (paypalLink) {
    paypalLink.addEventListener('click', requireAuth);
  }

  if (bankFields.length > 0) {
    const token = localStorage.getItem('nmAuthToken');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    fetch('/api/billing/bank-details', { headers })
      .then((response) => {
        if (response.status === 401 || response.status === 403) {
          throw new Error('unauthorized');
        }
        return response.json();
      })
      .then((data) => {
        const bank = data.bank || {};
        bankFields.forEach((field) => {
          const key = field.getAttribute('data-bank-field');
          if (!key) return;
          field.textContent = bank[key] || 'Not available';
        });
      })
      .catch((error) => {
        bankFields.forEach((field) => {
          field.textContent = error?.message === 'unauthorized'
            ? 'Sign in to view bank details.'
            : 'Not available';
        });
      });
  }

  const token = localStorage.getItem('nmAuthToken');
  if (token && invoiceForm) {
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => response.json())
      .then((data) => {
        if (data.user?.name) {
          const nameInput = document.getElementById('invoice-name');
          if (nameInput && !nameInput.value) nameInput.value = data.user.name;
        }
      })
      .catch(() => {});
  }
})();
