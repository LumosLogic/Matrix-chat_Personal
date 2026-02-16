/**
 * Registration Form Handler
 *
 * Handles the user registration flow:
 * 1. Reads token from URL
 * 2. Validates form input
 * 3. Submits to POST /register API
 * 4. Shows success/error states
 */

document.addEventListener('DOMContentLoaded', function () {
  // Get DOM elements
  const registerCard = document.getElementById('register-card');
  const successCard = document.getElementById('success-card');
  const invalidCard = document.getElementById('invalid-card');
  const usedCard = document.getElementById('used-card');
  const expiredCard = document.getElementById('expired-card');
  const loadingCard = document.getElementById('loading-card');
  const registerForm = document.getElementById('register-form');
  const errorMessage = document.getElementById('error-message');
  const submitBtn = document.getElementById('submit-btn');
  const btnText = submitBtn.querySelector('.btn-text');
  const btnLoading = submitBtn.querySelector('.btn-loading');
  const matrixIdDisplay = document.getElementById('matrix-id');

  // Form inputs
  const tokenInput = document.getElementById('token');
  const usernameInput = document.getElementById('username');
  const fullNameInput = document.getElementById('full_name');
  const passwordInput = document.getElementById('password');
  const confirmPasswordInput = document.getElementById('confirm_password');

  /**
   * Extract token from URL query parameters
   */
  function getTokenFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('token');
  }

  /**
   * Show error message
   */
  function showError(message) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
  }

  /**
   * Hide error message
   */
  function hideError() {
    errorMessage.style.display = 'none';
  }

  /**
   * Set loading state
   */
  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    btnText.style.display = isLoading ? 'none' : 'inline';
    btnLoading.style.display = isLoading ? 'inline' : 'none';
  }

  /**
   * Validate username format (Matrix localpart rules)
   */
  function isValidUsername(username) {
    // Matrix localpart: lowercase, numbers, and some special chars
    const pattern = /^[a-z0-9._=\-/]+$/;
    return pattern.test(username) && username.length >= 1 && username.length <= 64;
  }

  /**
   * Validate form inputs
   */
  function validateForm() {
    const username = usernameInput.value.trim().toLowerCase();
    const fullName = fullNameInput.value.trim();
    const password = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    // Check username
    if (!username) {
      showError('Username is required.');
      usernameInput.focus();
      return false;
    }

    if (!isValidUsername(username)) {
      showError('Username can only contain lowercase letters, numbers, and ._=-/ characters.');
      usernameInput.focus();
      return false;
    }

    // Check full name
    if (!fullName) {
      showError('Full name is required.');
      fullNameInput.focus();
      return false;
    }

    // Check password
    if (!password) {
      showError('Password is required.');
      passwordInput.focus();
      return false;
    }

    if (password.length < 8) {
      showError('Password must be at least 8 characters long.');
      passwordInput.focus();
      return false;
    }

    // Check password confirmation
    if (password !== confirmPassword) {
      showError('Passwords do not match.');
      confirmPasswordInput.focus();
      return false;
    }

    return true;
  }

  /**
   * Show success state
   */
  function showSuccess(matrixUserId) {
    registerCard.style.display = 'none';
    matrixIdDisplay.textContent = matrixUserId;
    successCard.style.display = 'block';
    successCard.scrollIntoView({ behavior: 'smooth' });
  }

  /**
   * Hide all cards
   */
  function hideAllCards() {
    registerCard.style.display = 'none';
    successCard.style.display = 'none';
    invalidCard.style.display = 'none';
    usedCard.style.display = 'none';
    expiredCard.style.display = 'none';
    loadingCard.style.display = 'none';
  }

  /**
   * Show loading state
   */
  function showLoadingState() {
    hideAllCards();
    loadingCard.style.display = 'block';
  }

  /**
   * Show invalid token state
   */
  function showInvalidToken() {
    hideAllCards();
    invalidCard.style.display = 'block';
  }

  /**
   * Show already used state
   */
  function showAlreadyUsed() {
    hideAllCards();
    usedCard.style.display = 'block';
  }

  /**
   * Show expired state
   */
  function showExpired() {
    hideAllCards();
    expiredCard.style.display = 'block';
  }

  /**
   * Show registration form
   */
  function showRegistrationForm() {
    hideAllCards();
    registerCard.style.display = 'block';
  }

  /**
   * Handle form submission
   */
  async function handleSubmit(event) {
    event.preventDefault();
    hideError();

    // Validate form
    if (!validateForm()) {
      return;
    }

    // Prepare data
    const data = {
      token: tokenInput.value,
      username: usernameInput.value.trim().toLowerCase(),
      full_name: fullNameInput.value.trim(),
      password: passwordInput.value,
    };

    setLoading(true);

    try {
      // Submit to API
      const response = await fetch('/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      const result = await response.json();

      if (!response.ok) {
        // Handle error response with reason for specific UI states
        const error = new Error(result.message || 'Registration failed. Please try again.');
        error.reason = result.reason;
        throw error;
      }

      // Success!
      console.log('Registration successful:', result);
      showSuccess(result.user.matrix_user_id);

    } catch (error) {
      console.error('Registration error:', error);

      // Handle specific error reasons by showing appropriate cards
      if (error.reason === 'used') {
        showAlreadyUsed();
        return;
      }
      if (error.reason === 'expired') {
        showExpired();
        return;
      }
      if (error.reason === 'invalid') {
        showInvalidToken();
        return;
      }

      showError(error.message || 'An unexpected error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  /**
   * Validate token with backend API
   */
  async function validateToken(token) {
    try {
      const response = await fetch(`/api/validate-token?token=${encodeURIComponent(token)}`);
      const result = await response.json();

      if (!response.ok) {
        return { valid: false, reason: result.reason || 'invalid' };
      }

      return { valid: true, email: result.email };
    } catch (error) {
      console.error('Token validation error:', error);
      return { valid: false, reason: 'error' };
    }
  }

  /**
   * Initialize the page
   */
  async function init() {
    // Get token from URL
    const token = getTokenFromUrl();

    if (!token) {
      // No token provided - show error
      showInvalidToken();
      return;
    }

    // Show loading while validating
    showLoadingState();

    // Validate token with backend
    const validation = await validateToken(token);

    if (!validation.valid) {
      // Show appropriate error based on reason
      switch (validation.reason) {
        case 'used':
          showAlreadyUsed();
          break;
        case 'expired':
          showExpired();
          break;
        default:
          showInvalidToken();
      }
      return;
    }

    // Token is valid - show registration form
    tokenInput.value = token;
    showRegistrationForm();

    // Add form submit handler
    registerForm.addEventListener('submit', handleSubmit);

    // Auto-lowercase username as user types
    usernameInput.addEventListener('input', function () {
      this.value = this.value.toLowerCase().replace(/[^a-z0-9._=\-/]/g, '');
    });

    // Clear error on input
    [usernameInput, fullNameInput, passwordInput, confirmPasswordInput].forEach(input => {
      input.addEventListener('input', hideError);
    });

    // Focus username field
    usernameInput.focus();
  }

  // Initialize
  init();
});
