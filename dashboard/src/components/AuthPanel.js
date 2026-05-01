import React, { useState } from "react";
import axios from "axios";
import API_BASE_URL from "../config/api";
import { clearSession, getStoredUser, setSession } from "../config/auth";

const AuthPanel = () => {
  const [user, setUser] = useState(getStoredUser());
  const [mode, setMode] = useState("login");
  const [name, setName] = useState("Demo Recruiter");
  const [email, setEmail] = useState("demo@marketlab.app");
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const syncPortfolio = () => {
    window.dispatchEvent(new Event("marketlab:auth-changed"));
    window.dispatchEvent(new Event("marketlab:order-filled"));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      const endpoint = mode === "login" ? "/auth/login" : "/auth/signup";
      const payload =
        mode === "login" ? { email, password } : { name, email, password };
      const res = await axios.post(`${API_BASE_URL}${endpoint}`, payload);
      setSession(res.data);
      setUser(res.data.user);
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
    syncPortfolio();
  };

  if (user) {
    return (
      <div className="auth-panel">
        <span>
          Signed in as <strong>{user.name}</strong>
        </span>
        <button className="btn btn-grey" onClick={handleLogout}>
          Logout
        </button>
      </div>
    );
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
      {error && <span className="auth-error">{error}</span>}
    </form>
  );
};

export default AuthPanel;
