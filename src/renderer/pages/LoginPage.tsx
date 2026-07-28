import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, useNetwork } from '../context';
import { LoginRequest } from '../types';

function LoginPage() {
  const navigate = useNavigate();
  const { login, isLoading, resetAuth } = useAuth();
  const { networkStatus } = useNetwork();
  const [credentials, setCredentials] = useState<LoginRequest>({
    email: '',
    password: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [showResetOption, setShowResetOption] = useState<boolean>(false);
  const [resetSuccess, setResetSuccess] = useState<boolean>(false);
  const [showPassword, setShowPassword] = useState<boolean>(false);

  const togglePasswordVisibility = () => {
    setShowPassword(!showPassword);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setCredentials((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  // Handle database reset
  const handleReset = async () => {
    try {
      await resetAuth();
      setResetSuccess(true);
      setShowResetOption(false);
      setError(null);
      // Reset success message will disappear after 3 seconds
      setTimeout(() => {
        setResetSuccess(false);
      }, 3000);
    } catch (err) {
      console.error('Reset error:', err);
      setError('Failed to reset. Please try again.');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setShowResetOption(false);

    if (!networkStatus.isOnline) {
      setError(
        'You are offline. Please check your internet connection to log in.',
      );
      return;
    }

    if (!credentials.email || !credentials.password) {
      setError('Please enter both email and password.');
      return;
    }

    try {
      const result = await login(credentials);
      if (!result.success) {
        setError(
          result.message || 'Invalid email or password. Please try again.',
        );
        // Offer the reset option on any failed login, regardless of the exact
        // server message — the previous string match broke when the backend
        // changed its wrong-password wording.
        setShowResetOption(true);
      } else {
        // Redirect to dashboard after successful login
        navigate('/');
      }
    } catch (err) {
      console.error('Login submission error:', err);
      setError(
        'An error occurred during login. You may need to reset the app data.',
      );
      setShowResetOption(true);
    }
  };

  return (
    <div className="login-container">
      <div className="login-form-container">
        <h1>Employee Tracker</h1>
        <p>Log in to track your work time</p>

        {!networkStatus.isOnline && (
          <div className="offline-warning">
            You are currently offline. You need to be online to log in.
          </div>
        )}

        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="email">
              Email
              <input
                type="email"
                id="email"
                name="email"
                value={credentials.email}
                onChange={handleChange}
                disabled={isLoading}
                placeholder="Enter your email"
                required
              />
            </label>
          </div>

          <div className="form-group">
            <label htmlFor="password">
              Password
              <div className="password-input-wrapper">
                <input
                  type={showPassword ? 'text' : 'password'}
                  id="password"
                  name="password"
                  value={credentials.password}
                  onChange={handleChange}
                  disabled={isLoading}
                  placeholder="Enter your password"
                  required
                />
                <button
                  type="button"
                  className="toggle-password-button"
                  onClick={togglePasswordVisibility}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </label>
          </div>

          {error && <div className="error-message">{error}</div>}

          {resetSuccess && (
            <div className="success-message">
              App data has been reset successfully. Please try logging in again.
            </div>
          )}

          <button
            type="submit"
            className="login-button"
            disabled={isLoading || !networkStatus.isOnline}
          >
            {isLoading ? (
              <>
                <span className="btn-spinner" />
                Logging in...
              </>
            ) : (
              'Log In'
            )}
          </button>

          {showResetOption && (
            <div className="reset-option">
              <p>Having trouble logging in? Try resetting the app data.</p>
              <button
                type="button"
                className="reset-button"
                onClick={handleReset}
                disabled={isLoading}
              >
                Reset App Data
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

export default LoginPage;
