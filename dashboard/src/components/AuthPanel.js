import React, { useEffect, useState } from "react";
import axios from "axios";
import API_BASE_URL from "../config/api";
import {
  clearSession,
  getAuthConfig,
  getToken,
  getStoredUser,
  setSession,
} from "../config/auth";

const AuthPanel = () => {
  const [user, setUser] = useState(getStoredUser());
  const [mode, setMode] = useState("login");
  const [name, setName] = useState("Demo Recruiter");
  const [email, setEmail] = useState("demo@marketlab.app");
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isCheckingSession, setIsCheckingSession] = useState(Boolean(getToken()));

  const syncPortfolio = () => {
    window.dispatchEvent(new Event("marketlab:auth-changed"));
    window.dispatchEvent(new Event("marketlab:order-filled"));
  };

  useEffect(() => {
    const token = getToken();

    if (!token) {
      setIsCheckingSession(false);
      return;
    }

    const validateSession = async () => {
      try {
        const response = await axios.get(`${API_BASE_URL}/auth/me`, getAuthConfig());
        setUser(response.data.user);
      } catch (err) {
        clearSession();
        setUser(null);
      } finally {
        setIsCheckingSession(false);
      }
    };

    validateSession();
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setNotice("");
    setIsSubmitting(true);

    try {
      const endpoint = mode === "login" ? "/auth/login" : "/auth/signup";
      const payload =
        mode === "login" ? { email, password } : { name, email, password };
      const res = await axios.post(`${API_BASE_URL}${endpoint}`, payload);
      setSession(res.data);
      setUser(res.data.user);
      setNotice("Demo session ready");
      syncPortfolio();
    } catch (err) {
      setError(err.response?.data?.message || "Authentication failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = () => {
    clearSession();
    setUser(null);
    setNotice("");
    syncPortfolio();
  };

  const handleReset = async () => {
    setError("");
    setNotice("");
    setIsResetting(true);

    try {
      await axios.post(`${API_BASE_URL}/demo/reset`, {}, getAuthConfig());
      setNotice("Demo reset. Portfolio, orders, and watchlist are clean.");
      syncPortfolio();
    } catch (err) {
      setError(err.response?.data?.message || "Unable to reset portfolio");
    } finally {
      setIsResetting(false);
    }
  };

  if (user) {
    return (
      <div className="auth-panel">
        <span>
          Signed in as <strong>{user.name}</strong>
        </span>
        <button className="btn btn-blue" onClick={handleReset} disabled={isResetting}>
          {isResetting ? "Resetting..." : "Reset Demo"}
        </button>
        <button className="btn btn-grey" onClick={handleLogout}>
          Logout
        </button>
        {notice && <span className="auth-notice">{notice}</span>}
        {error && <span className="auth-error">{error}</span>}
      </div>
    );
  }

  if (isCheckingSession) {
    return <div className="auth-panel">Restoring your demo session...</div>;
  }

  return (
    <form className="auth-panel" onSubmit={handleSubmit}>
      <strong>{mode === "login" ? "Login" : "Create account"}</strong>
      {mode === "signup" && (
        <input
          type="text"
          placeholder="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      )}
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <button className="btn btn-blue" type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Please wait..." : mode === "login" ? "Login" : "Sign up"}
      </button>
      <button
        className="btn btn-grey"
        type="button"
        onClick={() => setMode(mode === "login" ? "signup" : "login")}
      >
        {mode === "login" ? "New account" : "Have account"}
      </button>
      {notice && <span className="auth-notice">{notice}</span>}
      {error && <span className="auth-error">{error}</span>}
    </form>
  );
};

export default AuthPanel;
