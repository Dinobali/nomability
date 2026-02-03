(() => {
  const TOKEN_KEY = 'nmAuthToken';
  const modal = document.querySelector('[data-auth-modal]');
  const openButtons = Array.from(document.querySelectorAll('[data-auth-open]'));
  const closeButtons = Array.from(document.querySelectorAll('[data-auth-close]'));
  const tabButtons = Array.from(document.querySelectorAll('[data-auth-tab]'));
  const panels = Array.from(document.querySelectorAll('[data-auth-panel]'));
  const loginForm = document.querySelector('[data-auth-form="login"]');
  const registerForm = document.querySelector('[data-auth-form="register"]');
  const verifyForm = document.querySelector('[data-auth-form="verify"]');
  const loginStatus = document.querySelector('[data-auth-status="login"]');
  const registerStatus = document.querySelector('[data-auth-status="register"]');
  const verifyStatus = document.querySelector('[data-auth-status="verify"]');
  const resendButtons = Array.from(document.querySelectorAll('[data-auth-resend]'));
  const loggedInEls = Array.from(document.querySelectorAll('[data-auth-show="logged-in"]'));
  const loggedOutEls = Array.from(document.querySelectorAll('[data-auth-show="logged-out"]'));
  const initialsEls = Array.from(document.querySelectorAll('[data-auth-initials]'));
  const nameEls = Array.from(document.querySelectorAll('[data-auth-name]'));
  const emailEls = Array.from(document.querySelectorAll('[data-auth-email]'));
  const roleEls = Array.from(document.querySelectorAll('[data-auth-role]'));
  const avatarButtons = Array.from(document.querySelectorAll('[data-auth-avatar]'));
  const logoutButtons = Array.from(document.querySelectorAll('[data-auth-logout]'));
  let pendingVerificationEmail = '';

  const getInitials = (value) => {
    const trimmed = (value || '').trim();
    if (!trimmed) return 'U';
    const parts = trimmed.split(' ').filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
    }
    return trimmed.slice(0, 2).toUpperCase();
  };

  const setAuthVisibility = (isLoggedIn) => {
    loggedInEls.forEach((el) => {
      el.hidden = !isLoggedIn;
    });
    loggedOutEls.forEach((el) => {
      el.hidden = isLoggedIn;
    });
    if (!isLoggedIn) closeProfileMenus();
  };

  const setUser = (user) => {
    const displayName = user?.name || user?.email || 'Account';
    initialsEls.forEach((el) => {
      el.textContent = getInitials(displayName);
    });
    nameEls.forEach((el) => {
      el.textContent = user?.name || 'Account';
    });
    emailEls.forEach((el) => {
      el.textContent = user?.email || '';
    });
  };

  const setRoleVisibility = (role) => {
    roleEls.forEach((el) => {
      const required = (el.dataset.authRole || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const allowed = role && required.includes(role);
      el.hidden = !allowed;
    });
  };

  const closeProfileMenus = () => {
    document.querySelectorAll('[data-auth-menu]').forEach((menu) => {
      menu.classList.remove('is-open');
      menu.hidden = true;
    });
    avatarButtons.forEach((button) => {
      button.setAttribute('aria-expanded', 'false');
    });
  };

  const openProfileMenu = (button) => {
    const wrapper = button.closest('[data-auth-show="logged-in"]') || button.closest('[data-auth-profile]') || button.parentElement;
    const menu = wrapper ? wrapper.querySelector('[data-auth-menu]') : null;
    if (!menu) return;
    const isOpen = menu.classList.contains('is-open');
    closeProfileMenus();
    if (!isOpen) {
      menu.hidden = false;
      menu.classList.add('is-open');
      button.setAttribute('aria-expanded', 'true');
    }
  };

  const setActiveTab = (tab) => {
    tabButtons.forEach((button) => {
      const isActive = button.dataset.authTab === tab;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', String(isActive));
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.authPanel !== tab;
    });
    if (loginStatus) loginStatus.textContent = '';
    if (registerStatus) registerStatus.textContent = '';
    if (verifyStatus) {
      verifyStatus.textContent = '';
      verifyStatus.hidden = true;
    }
    if (tab === 'register') {
      resetRegisterPanel();
    }
    const activePanel = panels.find((panel) => panel.dataset.authPanel === tab);
    const firstInput = activePanel?.querySelector('input, select, textarea, button');
    if (firstInput) firstInput.focus();
  };

  const openModal = (tab) => {
    if (!modal) return;
    modal.hidden = false;
    modal.classList.add('is-open');
    document.body.classList.add('nm-modal-open');
    setActiveTab(tab || 'login');
  };

  const closeModal = () => {
    if (!modal) return;
    modal.classList.remove('is-open');
    modal.hidden = true;
    document.body.classList.remove('nm-modal-open');
  };

  const setVerifyEmail = (email) => {
    if (!verifyForm) return;
    const emailInput = verifyForm.querySelector('[data-auth-input="verify-email"]');
    if (emailInput && typeof email === 'string') {
      emailInput.value = email;
    }
  };

  const resetRegisterPanel = () => {
    if (registerForm) registerForm.hidden = false;
    if (verifyForm) verifyForm.hidden = true;
    if (verifyStatus) {
      verifyStatus.textContent = '';
      verifyStatus.hidden = true;
    }
  };

  const showVerificationStep = (email, message) => {
    setActiveTab('register');
    pendingVerificationEmail = email;
    setVerifyEmail(email);
    if (registerForm) registerForm.hidden = true;
    if (verifyForm) verifyForm.hidden = false;
    if (verifyStatus) {
      verifyStatus.hidden = false;
      verifyStatus.textContent = message || 'Enter the verification code from your inbox.';
    }
  };

  const requestVerification = async (email) => {
    if (!email) {
      if (verifyStatus) {
        verifyStatus.hidden = false;
        verifyStatus.textContent = 'Enter your email to send a verification code.';
      }
      return false;
    }
    if (verifyStatus) {
      verifyStatus.hidden = false;
      verifyStatus.textContent = 'Sending verification code...';
    }
    try {
      const response = await fetch('/api/auth/email-verification/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (verifyStatus) {
          verifyStatus.hidden = false;
          verifyStatus.textContent = data.error || 'Failed to send verification code.';
        }
        return false;
      }
      if (verifyStatus) {
        verifyStatus.hidden = false;
        verifyStatus.textContent = 'Verification code sent. Check your inbox.';
      }
      return true;
    } catch (error) {
      if (verifyStatus) {
        verifyStatus.hidden = false;
        verifyStatus.textContent = 'Failed to send verification code.';
      }
      return false;
    }
  };

  const fetchUser = async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setAuthVisibility(false);
      setUser(null);
      setRoleVisibility(null);
      return;
    }
    setAuthVisibility(true);
    try {
      const response = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.status === 401 || response.status === 403) {
        localStorage.removeItem(TOKEN_KEY);
        setUser(null);
        setAuthVisibility(false);
        setRoleVisibility(null);
        return;
      }
      if (!response.ok) throw new Error('Failed');
      const data = await response.json().catch(() => ({}));
      if (!data.user) throw new Error('Missing user');
      setUser(data.user);
      setRoleVisibility(data.membership?.role || null);
    } catch (error) {
      // Keep the optimistic logged-in state if the network is unavailable.
      setRoleVisibility(null);
    }
  };

  openButtons.forEach((button) => {
    button.addEventListener('click', (event) => {
      if (!modal) return;
      event.preventDefault();
      const tab = button.dataset.authOpen || 'login';
      openModal(tab);
    });
  });

  closeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      closeModal();
    });
  });

  if (modal) {
    const dialog = modal.querySelector('.nm-auth-dialog');
    if (dialog) {
      dialog.addEventListener('click', (event) => event.stopPropagation());
    }
    modal.addEventListener('click', () => {
      if (modal.classList.contains('is-open')) closeModal();
    });
  }

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setActiveTab(button.dataset.authTab || 'login');
    });
  });

  avatarButtons.forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openProfileMenu(button);
    });
  });

  logoutButtons.forEach((button) => {
    button.addEventListener('click', () => {
      localStorage.removeItem(TOKEN_KEY);
      closeProfileMenus();
      setAuthVisibility(false);
      setUser(null);
      setRoleVisibility(null);
    });
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-auth-menu]') && !event.target.closest('[data-auth-avatar]')) {
      closeProfileMenus();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (modal && modal.classList.contains('is-open')) {
        closeModal();
      }
      closeProfileMenus();
    }
  });

  if (loginForm) {
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (loginStatus) loginStatus.textContent = 'Signing in...';
      const email = loginForm.querySelector('[data-auth-input="login-email"]')?.value?.trim() || '';
      const password = loginForm.querySelector('[data-auth-input="login-password"]')?.value || '';
      try {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (data?.code === 'EMAIL_NOT_VERIFIED' || data?.verificationRequired) {
            showVerificationStep(email, 'Email not verified. Enter the code from your inbox or resend it.');
            return;
          }
          if (loginStatus) loginStatus.textContent = data.error || 'Login failed.';
          return;
        }
        localStorage.setItem(TOKEN_KEY, data.token);
        await fetchUser();
        closeModal();
      } catch (error) {
        if (loginStatus) loginStatus.textContent = 'Login failed. Please try again.';
      }
    });
  }

  if (registerForm) {
    registerForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (registerStatus) registerStatus.textContent = 'Creating account...';
      const payload = {
        name: registerForm.querySelector('[data-auth-input="register-name"]')?.value?.trim() || '',
        orgName: registerForm.querySelector('[data-auth-input="register-org"]')?.value?.trim() || '',
        email: registerForm.querySelector('[data-auth-input="register-email"]')?.value?.trim() || '',
        password: registerForm.querySelector('[data-auth-input="register-password"]')?.value || ''
      };
      try {
        const response = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (registerStatus) registerStatus.textContent = data.error || 'Registration failed.';
          return;
        }
        if (data?.token) {
          localStorage.setItem(TOKEN_KEY, data.token);
          await fetchUser();
          closeModal();
          return;
        }
        showVerificationStep(payload.email, 'We sent a verification code to your email. Enter it below to finish.');
      } catch (error) {
        if (registerStatus) registerStatus.textContent = 'Registration failed. Please try again.';
      }
    });
  }

  if (verifyForm) {
    verifyForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (verifyStatus) {
        verifyStatus.hidden = false;
        verifyStatus.textContent = 'Verifying...';
      }
      const email = verifyForm.querySelector('[data-auth-input="verify-email"]')?.value?.trim() || pendingVerificationEmail;
      const code = verifyForm.querySelector('[data-auth-input="verify-code"]')?.value?.trim() || '';
      try {
        const response = await fetch('/api/auth/email-verification/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, code })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (verifyStatus) {
            verifyStatus.hidden = false;
            verifyStatus.textContent = data.error || 'Verification failed.';
          }
          return;
        }
        if (data?.token) {
          localStorage.setItem(TOKEN_KEY, data.token);
          await fetchUser();
          closeModal();
          return;
        }
        if (verifyStatus) {
          verifyStatus.hidden = false;
          verifyStatus.textContent = 'Email verified. You can log in now.';
        }
      } catch (error) {
        if (verifyStatus) {
          verifyStatus.hidden = false;
          verifyStatus.textContent = 'Verification failed. Please try again.';
        }
      }
    });
  }

  if (resendButtons.length) {
    resendButtons.forEach((button) => {
      button.addEventListener('click', async () => {
        const email = verifyForm?.querySelector('[data-auth-input="verify-email"]')?.value?.trim() || pendingVerificationEmail;
        await requestVerification(email);
      });
    });
  }

  fetchUser();
})();
