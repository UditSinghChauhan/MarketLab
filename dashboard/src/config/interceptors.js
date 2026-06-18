/**
 * Global axios interceptor — auto-clears the session and notifies the
 * rest of the app whenever the API returns 401 (token expired or invalid).
 *
 * Import this file once at the app entry point (index.js).
 * It has no exports; the side-effect of importing it is the setup itself.
 */
import axios from "axios";
import { clearSession } from "./auth";

axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      clearSession();
      // Notify all dashboard components to reset their auth-dependent state
      window.dispatchEvent(new Event("marketlab:auth-changed"));
    }
    return Promise.reject(error);
  }
);
