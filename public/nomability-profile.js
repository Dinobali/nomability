(() => {
  const token = localStorage.getItem('nmAuthToken');
  if (!token) {
    window.location.href = 'login.html?redirect=profile.html';
    return;
  }

  const headers = { Authorization: `Bearer ${token}` };

  const profileName = document.querySelector('[data-profile-name]');
  const profileEmail = document.querySelector('[data-profile-email]');
  const profileInitials = document.querySelector('[data-profile-initials]');
  const profileOrg = document.querySelector('[data-profile-org]');
  const profileMemberSince = document.querySelector('[data-profile-member-since]');
  const copyEmailBtn = document.getElementById('copy-email-btn');

  const overviewPlan = document.getElementById('overview-plan');
  const overviewStatus = document.getElementById('overview-status');
  const overviewPeriod = document.getElementById('overview-period');
  const overviewUsage = document.getElementById('overview-usage');
  const overviewIncluded = document.getElementById('overview-included');
  const overviewCredits = document.getElementById('overview-credits');
  const usageProgress = document.getElementById('usage-progress');
  const usageCaption = document.getElementById('usage-caption');
  const usageRenewal = document.getElementById('usage-renewal');
  const overviewInvoices = document.getElementById('overview-invoices');

  const subscriptionPlan = document.getElementById('subscription-plan');
  const subscriptionStatus = document.getElementById('subscription-status');
  const subscriptionPeriod = document.getElementById('subscription-period');
  const subscriptionIncluded = document.getElementById('subscription-included');
  const subscriptionUsed = document.getElementById('subscription-used');
  const subscriptionCredits = document.getElementById('subscription-credits');

  const stripeInvoices = document.getElementById('stripe-invoices');
  const manualInvoices = document.getElementById('manual-invoices');
  const bankFields = document.querySelectorAll('[data-bank-field]');
  const copyBankBtn = document.getElementById('copy-bank-btn');
  const bankPdfBtn = document.getElementById('bank-pdf-btn');

  const profileForm = document.getElementById('profile-form');
  const profileNameInput = document.getElementById('profile-name-input');
  const profileOrgInput = document.getElementById('profile-org-input');
  const profileEmailInput = document.getElementById('profile-email-input');
  const profileEmailPassword = document.getElementById('profile-email-password');
  const profileStatus = document.getElementById('profile-status');
  const actionStatus = document.getElementById('action-status');
  const orgRoleNote = document.getElementById('org-role-note');

  const passwordForm = document.getElementById('password-form');
  const currentPasswordInput = document.getElementById('current-password');
  const newPasswordInput = document.getElementById('new-password');
  const confirmPasswordInput = document.getElementById('confirm-password');
  const passwordStatus = document.getElementById('password-status');

  const resetPasswordBtn = document.getElementById('password-reset-btn');
  const resetStatus = document.getElementById('reset-status');

  const paygInlineInput = document.getElementById('payg-hours-inline');

  const state = {
    user: null,
    org: null,
    role: null,
    bank: null,
    stripe: [],
    manual: []
  };

  const planMap = {
    starter: 'Starter',
    pro: 'Pro',
    unlimited: 'Unlimited',
    payg: 'PAYG'
  };

  const getInitials = (value) => {
    const trimmed = (value || '').trim();
    if (!trimmed) return 'U';
    const parts = trimmed.split(' ').filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
    }
    return trimmed.slice(0, 2).toUpperCase();
  };

  const formatDate = (value) => {
    if (!value) return '—';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatCurrency = (amount, currency = 'EUR') => {
    if (amount == null || Number.isNaN(amount)) return '—';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency
    }).format(amount);
  };

  const formatMinutes = (value) => {
    if (value == null || Number.isNaN(value)) return '—';
    return `${Number(value).toFixed(1)} min`;
  };

  const escapeHtml = (value) => {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return String(value ?? '').replace(/[&<>"']/g, (char) => map[char]);
  };

  const setMessage = (el, message, type = 'info') => {
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = '';
      el.classList.remove('is-error', 'is-success');
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle('is-error', type === 'error');
    el.classList.toggle('is-success', type === 'success');
  };

  const handleUnauthorized = (response) => {
    if (response.status === 401 || response.status === 403) {
      localStorage.removeItem('nmAuthToken');
      window.location.href = 'login.html?redirect=profile.html';
      return true;
    }
    return false;
  };

  const openPrintWindow = (title, bodyHtml) => {
    const win = window.open('', '_blank');
    if (!win) return false;
    win.document.write(`<!doctype html><html><head><title>${escapeHtml(title)}</title><style>
      body { font-family: 'Manrope', Arial, sans-serif; color: #0f172a; margin: 40px; }
      h1 { font-size: 24px; margin-bottom: 6px; }
      h2 { font-size: 18px; margin: 24px 0 8px; }
      p { margin: 4px 0; }
      .section { margin-top: 18px; }
      .muted { color: #475569; font-size: 13px; }
      .table { display: grid; gap: 6px; font-size: 14px; }
      .row { display: flex; justify-content: space-between; gap: 16px; }
      .row span:first-child { font-weight: 600; }
      .box { border: 1px solid #cbd5f5; border-radius: 12px; padding: 14px; }
      @media print { body { margin: 20mm; } }
    </style></head><body>${bodyHtml}</body></html>`);
    win.document.close();
    setTimeout(() => {
      win.focus();
      win.print();
    }, 300);
    return true;
  };

  const copyToClipboard = async (text) => {
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const temp = document.createElement('textarea');
        temp.value = text;
        temp.style.position = 'fixed';
        temp.style.opacity = '0';
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
      }
      return true;
    } catch (error) {
      return false;
    }
  };

  const setProfileBasics = () => {
    if (!state.user) return;
    const name = state.user.name || 'Account';
    if (profileName) profileName.textContent = name;
    if (profileEmail) profileEmail.textContent = state.user.email || '';
    if (profileInitials) profileInitials.textContent = getInitials(name);
    if (profileOrg) profileOrg.textContent = state.org?.name || '—';
    if (profileMemberSince) profileMemberSince.textContent = formatDate(state.user.createdAt);

    if (profileNameInput) profileNameInput.value = state.user.name || '';
    if (profileOrgInput) {
      profileOrgInput.value = state.org?.name || '';
      const orgEditable = !state.role || state.role === 'owner';
      profileOrgInput.disabled = !orgEditable;
      if (orgRoleNote) orgRoleNote.hidden = orgEditable;
    }
    if (profileEmailInput) profileEmailInput.value = state.user.email || '';
  };

  const loadProfile = async () => {
    try {
      const response = await fetch('/api/auth/me', { headers });
      if (handleUnauthorized(response)) return;
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(profileStatus, data.error || 'Failed to load profile.', 'error');
        return;
      }
      state.user = data.user || null;
      state.org = data.org || null;
      state.role = data.membership?.role || null;
      setProfileBasics();
    } catch (error) {
      setMessage(profileStatus, 'Failed to load profile.', 'error');
    }
  };

  const updateUsageBlocks = (data) => {
    const planLabel = data.planLabel || 'No plan';
    const status = data.subscription?.status || 'none';
    const periodEnd = data.subscription?.currentPeriodEnd
      ? formatDate(data.subscription.currentPeriodEnd)
      : '—';
    const included = data.unlimited ? 'Unlimited' : `${data.includedMinutes || 0} min`;
    const used = Number(data.usageThisMonth || 0);
    const credits = data.credits || 0;

    if (overviewPlan) overviewPlan.textContent = planLabel;
    if (overviewStatus) overviewStatus.textContent = `Status: ${status}`;
    if (overviewPeriod) overviewPeriod.textContent = `Renews: ${periodEnd}`;
    if (overviewUsage) overviewUsage.textContent = formatMinutes(used);
    if (overviewIncluded) overviewIncluded.textContent = `Included: ${included}`;
    if (overviewCredits) overviewCredits.textContent = `${credits} min`;

    if (subscriptionPlan) subscriptionPlan.textContent = planLabel;
    if (subscriptionStatus) subscriptionStatus.textContent = status;
    if (subscriptionPeriod) subscriptionPeriod.textContent = periodEnd;
    if (subscriptionIncluded) subscriptionIncluded.textContent = included;
    if (subscriptionUsed) subscriptionUsed.textContent = formatMinutes(used);
    if (subscriptionCredits) subscriptionCredits.textContent = `${credits} min`;

    if (usageCaption) {
      usageCaption.textContent = data.unlimited
        ? `Used ${formatMinutes(used)} · Unlimited plan`
        : `${formatMinutes(used)} of ${data.includedMinutes || 0} min used`;
    }
    if (usageRenewal) {
      usageRenewal.textContent = data.subscription?.currentPeriodEnd
        ? `Renews ${periodEnd}`
        : 'No active renewal';
    }

    if (usageProgress) {
      let percent = 0;
      if (data.unlimited) {
        percent = 100;
      } else if (data.includedMinutes) {
        percent = Math.min(100, Math.round((used / data.includedMinutes) * 100));
      }
      usageProgress.style.width = `${percent}%`;
    }
  };

  const loadUsage = async () => {
    try {
      const response = await fetch('/api/billing/status', { headers });
      if (handleUnauthorized(response)) return;
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (overviewPlan) overviewPlan.textContent = 'Unavailable';
        if (overviewStatus) overviewStatus.textContent = data.error || 'Failed to load usage.';
        return;
      }
      updateUsageBlocks(data);
    } catch (error) {
      if (overviewPlan) overviewPlan.textContent = 'Unavailable';
      if (overviewStatus) overviewStatus.textContent = 'Failed to load usage.';
    }
  };

  const renderStripeInvoices = (invoices, container, limit = null) => {
    if (!container) return;
    container.innerHTML = '';
    if (!invoices?.length) {
      container.textContent = 'No Stripe invoices yet.';
      return;
    }

    const list = limit ? invoices.slice(0, limit) : invoices;
    list.forEach((invoice) => {
      const row = document.createElement('div');
      row.className = 'nm-invoice-item';

      const title = document.createElement('div');
      title.className = 'nm-invoice-title';

      const number = invoice.number || invoice.id || 'Invoice';
      const amount = (invoice.amount_paid || invoice.amount_due || 0) / 100;
      const currency = invoice.currency ? String(invoice.currency).toUpperCase() : 'EUR';
      title.textContent = `${number} · ${formatCurrency(amount, currency)} · ${invoice.status || 'unknown'}`;

      const meta = document.createElement('div');
      meta.className = 'nm-invoice-meta';
      const created = invoice.created ? formatDate(new Date(invoice.created * 1000)) : '—';
      meta.textContent = `Created ${created}`;

      row.appendChild(title);
      row.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'nm-inline-actions';
      if (invoice.hosted_invoice_url) {
        const view = document.createElement('a');
        view.href = invoice.hosted_invoice_url;
        view.target = '_blank';
        view.rel = 'noopener';
        view.textContent = 'View invoice';
        actions.appendChild(view);
      }
      if (invoice.invoice_pdf) {
        const pdf = document.createElement('a');
        pdf.href = invoice.invoice_pdf;
        pdf.target = '_blank';
        pdf.rel = 'noopener';
        pdf.textContent = 'Download PDF';
        actions.appendChild(pdf);
      }
      if (actions.childNodes.length > 0) {
        row.appendChild(actions);
      }

      container.appendChild(row);
    });
  };

  const buildInvoicePdf = (invoice) => {
    const bank = state.bank || {};
    const currency = invoice.currency ? String(invoice.currency).toUpperCase() : 'EUR';
    const planLabel = planMap[invoice.planKey] || invoice.planKey || 'Plan';
    const body = `
      <h1>Nomability Invoice</h1>
      <p class="muted">Generated on ${escapeHtml(formatDate(new Date()))}</p>
      <div class="section box">
        <div class="table">
          <div class="row"><span>Invoice</span><span>${escapeHtml(invoice.invoiceNumber || '—')}</span></div>
          <div class="row"><span>Status</span><span>${escapeHtml(invoice.status || 'pending')}</span></div>
          <div class="row"><span>Plan</span><span>${escapeHtml(planLabel)}</span></div>
          <div class="row"><span>Amount</span><span>${escapeHtml(formatCurrency(invoice.amountCents / 100, currency))}</span></div>
          <div class="row"><span>Created</span><span>${escapeHtml(formatDate(invoice.createdAt))}</span></div>
          <div class="row"><span>Due</span><span>${escapeHtml(formatDate(invoice.dueDate))}</span></div>
        </div>
      </div>
      <div class="section">
        <h2>Billing details</h2>
        <div class="box">
          <div class="table">
            <div class="row"><span>Name</span><span>${escapeHtml(invoice.billingName || '—')}</span></div>
            <div class="row"><span>Address</span><span>${escapeHtml(invoice.billingAddress || '—')}</span></div>
            <div class="row"><span>Phone</span><span>${escapeHtml(invoice.billingPhone || '—')}</span></div>
          </div>
        </div>
      </div>
      <div class="section">
        <h2>Bank details</h2>
        <div class="box">
          <div class="table">
            <div class="row"><span>Account holder</span><span>${escapeHtml(bank.accountHolder || '—')}</span></div>
            <div class="row"><span>IBAN</span><span>${escapeHtml(bank.iban || '—')}</span></div>
            <div class="row"><span>BIC</span><span>${escapeHtml(bank.bic || '—')}</span></div>
            <div class="row"><span>Bank</span><span>${escapeHtml(bank.bankName || '—')}</span></div>
            <div class="row"><span>Reference</span><span>${escapeHtml(invoice.invoiceNumber || 'Invoice')}</span></div>
          </div>
        </div>
      </div>
      <p class="muted">Use the invoice number as the transfer reference.</p>
    `;

    openPrintWindow(`Nomability Invoice ${invoice.invoiceNumber || ''}`, body);
  };

  const renderManualInvoices = (invoices) => {
    if (!manualInvoices) return;
    manualInvoices.innerHTML = '';
    if (!invoices?.length) {
      manualInvoices.textContent = 'No invoice requests yet.';
      return;
    }

    invoices.forEach((invoice) => {
      const row = document.createElement('div');
      row.className = 'nm-invoice-item';

      const title = document.createElement('div');
      title.className = 'nm-invoice-title';
      const currency = invoice.currency ? String(invoice.currency).toUpperCase() : 'EUR';
      const planLabel = planMap[invoice.planKey] || invoice.planKey || 'Plan';
      title.textContent = `${invoice.invoiceNumber} · ${planLabel} · ${formatCurrency(invoice.amountCents / 100, currency)} · ${invoice.status || 'pending'}`;

      const meta = document.createElement('div');
      meta.className = 'nm-invoice-meta';
      meta.textContent = `Created ${formatDate(invoice.createdAt)} · Due ${formatDate(invoice.dueDate)}`;

      const actions = document.createElement('div');
      actions.className = 'nm-inline-actions';
      const pdfBtn = document.createElement('button');
      pdfBtn.type = 'button';
      pdfBtn.className = 'nm-btn nm-btn-ghost nm-btn-sm';
      pdfBtn.textContent = 'Download payment PDF';
      pdfBtn.addEventListener('click', () => buildInvoicePdf(invoice));
      actions.appendChild(pdfBtn);

      row.appendChild(title);
      row.appendChild(meta);
      row.appendChild(actions);

      manualInvoices.appendChild(row);
    });
  };

  const loadStripeInvoices = async () => {
    try {
      const response = await fetch('/api/billing/invoices', { headers });
      if (handleUnauthorized(response)) return;
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (stripeInvoices) stripeInvoices.textContent = data.error || 'Failed to load invoices.';
        if (overviewInvoices) overviewInvoices.textContent = data.error || 'Failed to load invoices.';
        return;
      }
      state.stripe = data.invoices || [];
      renderStripeInvoices(state.stripe, stripeInvoices);
      renderStripeInvoices(state.stripe, overviewInvoices, 3);
    } catch (error) {
      if (stripeInvoices) stripeInvoices.textContent = 'Failed to load invoices.';
      if (overviewInvoices) overviewInvoices.textContent = 'Failed to load invoices.';
    }
  };

  const loadManualInvoices = async () => {
    try {
      const response = await fetch('/api/billing/invoice', { headers });
      if (handleUnauthorized(response)) return;
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (manualInvoices) manualInvoices.textContent = data.error || 'Failed to load invoice requests.';
        return;
      }
      state.manual = data.invoices || [];
      renderManualInvoices(state.manual);
    } catch (error) {
      if (manualInvoices) manualInvoices.textContent = 'Failed to load invoice requests.';
    }
  };

  const loadBankDetails = async () => {
    if (bankFields.length === 0) return;
    try {
      const response = await fetch('/api/billing/bank-details');
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        bankFields.forEach((field) => {
          field.textContent = data.error || 'Not available';
        });
        return;
      }
      state.bank = data.bank || null;
      bankFields.forEach((field) => {
        const key = field.getAttribute('data-bank-field');
        if (!key) return;
        field.textContent = state.bank?.[key] || 'Not available';
      });
    } catch (error) {
      bankFields.forEach((field) => {
        field.textContent = 'Not available';
      });
    }
  };

  const loadAll = async () => {
    await Promise.all([loadProfile(), loadUsage(), loadStripeInvoices(), loadManualInvoices()]);
    await loadBankDetails();
  };

  const handlePortal = async () => {
    const response = await fetch('/api/billing/portal', { method: 'POST', headers });
    if (handleUnauthorized(response)) return;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(actionStatus || profileStatus, data.error || 'Failed to open portal.', 'error');
      return;
    }
    if (data.url) window.location.href = data.url;
  };

  const handlePayg = async (input) => {
    const hours = Math.max(1, Math.floor(Number(input?.value || 1)));
    const response = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'payg', hours })
    });
    if (handleUnauthorized(response)) return;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(actionStatus || profileStatus, data.error || 'Failed to start checkout.', 'error');
      return;
    }
    if (data.url) window.location.href = data.url;
  };

  const tabs = Array.from(document.querySelectorAll('[data-profile-tab]'));
  const panels = Array.from(document.querySelectorAll('[data-profile-panel]'));
  const availableTabs = new Set(panels.map((panel) => panel.dataset.profilePanel));

  const setActiveTab = (tab) => {
    const nextTab = availableTabs.has(tab) ? tab : 'overview';
    tabs.forEach((button) => {
      const isActive = button.dataset.profileTab === nextTab;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', String(isActive));
    });
    let activePanel = null;
    panels.forEach((panel) => {
      const isActive = panel.dataset.profilePanel === nextTab;
      panel.hidden = !isActive;
      if (isActive) activePanel = panel;
    });
    if (nextTab) {
      history.replaceState({}, document.title, `#${nextTab}`);
    }
    if (activePanel && window.innerWidth < 900) {
      setTimeout(() => {
        activePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    }
  };

  tabs.forEach((button) => {
    button.addEventListener('click', () => {
      setActiveTab(button.dataset.profileTab || 'overview');
    });
  });

  document.querySelectorAll('[data-profile-jump]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.getAttribute('data-profile-jump');
      if (target) setActiveTab(target);
    });
  });

  const hashTab = window.location.hash.replace('#', '');
  setActiveTab(hashTab || 'overview');

  window.addEventListener('hashchange', () => {
    const nextHash = window.location.hash.replace('#', '');
    setActiveTab(nextHash || 'overview');
  });

  document.querySelectorAll('[data-portal-action]').forEach((button) => {
    button.addEventListener('click', handlePortal);
  });

  document.querySelectorAll('[data-payg-action]').forEach((button) => {
    button.addEventListener('click', () => handlePayg(paygInlineInput));
  });

  document.querySelectorAll('[data-refresh]').forEach((button) => {
    button.addEventListener('click', loadAll);
  });

  if (copyEmailBtn) {
    copyEmailBtn.addEventListener('click', async () => {
      const ok = await copyToClipboard(state.user?.email || '');
      setMessage(actionStatus || profileStatus, ok ? 'Email copied to clipboard.' : 'Unable to copy email.', ok ? 'success' : 'error');
    });
  }

  if (copyBankBtn) {
    copyBankBtn.addEventListener('click', async () => {
      if (!state.bank) {
        setMessage(actionStatus || profileStatus, 'Bank details not available.', 'error');
        return;
      }
      const text = `Account holder: ${state.bank.accountHolder || ''}\nIBAN: ${state.bank.iban || ''}\nBIC: ${state.bank.bic || ''}\nBank: ${state.bank.bankName || ''}`;
      const ok = await copyToClipboard(text);
      setMessage(actionStatus || profileStatus, ok ? 'Bank details copied.' : 'Unable to copy bank details.', ok ? 'success' : 'error');
    });
  }

  if (bankPdfBtn) {
    bankPdfBtn.addEventListener('click', () => {
      if (!state.bank) {
        setMessage(actionStatus || profileStatus, 'Bank details not available.', 'error');
        return;
      }
      const body = `
        <h1>Nomability Bank Details</h1>
        <p class="muted">Generated on ${escapeHtml(formatDate(new Date()))}</p>
        <div class="section box">
          <div class="table">
            <div class="row"><span>Account holder</span><span>${escapeHtml(state.bank.accountHolder || '—')}</span></div>
            <div class="row"><span>IBAN</span><span>${escapeHtml(state.bank.iban || '—')}</span></div>
            <div class="row"><span>BIC</span><span>${escapeHtml(state.bank.bic || '—')}</span></div>
            <div class="row"><span>Bank</span><span>${escapeHtml(state.bank.bankName || '—')}</span></div>
          </div>
        </div>
        <p class="muted">Use the invoice number as the transfer reference.</p>
      `;
      openPrintWindow('Nomability Bank Details', body);
    });
  }

  if (profileForm) {
    profileForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      setMessage(profileStatus, 'Saving changes...');
      const payload = {};
      const name = profileNameInput?.value?.trim() || '';
      const orgName = profileOrgInput?.value?.trim() || '';
      const email = profileEmailInput?.value?.trim() || '';
      const emailPassword = profileEmailPassword?.value || '';

      if (state.user && name !== (state.user.name || '')) payload.name = name;
      if (state.org && orgName !== (state.org.name || '')) payload.orgName = orgName;
      if (email && state.user && email !== (state.user.email || '')) {
        if (!emailPassword) {
          setMessage(profileStatus, 'Enter your current password to change email.', 'error');
          return;
        }
        payload.email = email;
        payload.currentPassword = emailPassword;
      }

      if (!Object.keys(payload).length) {
        setMessage(profileStatus, 'No changes to save.', 'error');
        return;
      }

      try {
        const response = await fetch('/api/auth/me', {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (handleUnauthorized(response)) return;
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setMessage(profileStatus, data.error || 'Failed to update profile.', 'error');
          return;
        }
        state.user = data.user || state.user;
        state.org = data.org || state.org;
        setProfileBasics();
        if (profileEmailPassword) profileEmailPassword.value = '';
        setMessage(profileStatus, 'Profile updated.', 'success');
      } catch (error) {
        setMessage(profileStatus, 'Failed to update profile.', 'error');
      }
    });
  }

  if (passwordForm) {
    passwordForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const currentPassword = currentPasswordInput?.value || '';
      const newPassword = newPasswordInput?.value || '';
      const confirmPassword = confirmPasswordInput?.value || '';

      if (!currentPassword || !newPassword) {
        setMessage(passwordStatus, 'Please fill in all password fields.', 'error');
        return;
      }
      if (newPassword.length < 8) {
        setMessage(passwordStatus, 'Password must be at least 8 characters.', 'error');
        return;
      }
      if (newPassword !== confirmPassword) {
        setMessage(passwordStatus, 'Passwords do not match.', 'error');
        return;
      }

      setMessage(passwordStatus, 'Updating password...');
      try {
        const response = await fetch('/api/auth/password-change', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword })
        });
        if (handleUnauthorized(response)) return;
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setMessage(passwordStatus, data.error || 'Failed to update password.', 'error');
          return;
        }
        setMessage(passwordStatus, 'Password updated.', 'success');
        if (currentPasswordInput) currentPasswordInput.value = '';
        if (newPasswordInput) newPasswordInput.value = '';
        if (confirmPasswordInput) confirmPasswordInput.value = '';
      } catch (error) {
        setMessage(passwordStatus, 'Failed to update password.', 'error');
      }
    });
  }

  if (resetPasswordBtn) {
    resetPasswordBtn.addEventListener('click', async () => {
      if (!state.user?.email) {
        setMessage(resetStatus, 'Email not available.', 'error');
        return;
      }
      setMessage(resetStatus, 'Sending reset link...');
      try {
        const response = await fetch('/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: state.user.email })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setMessage(resetStatus, data.error || 'Failed to send reset email.', 'error');
          return;
        }
        setMessage(resetStatus, 'Reset email sent. Check your inbox.', 'success');
      } catch (error) {
        setMessage(resetStatus, 'Failed to send reset email.', 'error');
      }
    });
  }

  loadAll();
})();
