/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import RegisterStaff from './pages/RegisterStaff';
import ScheduleMonth from './pages/ScheduleMonth';
import Dashboard from './pages/Dashboard';
import Admin from './pages/Admin';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<RegisterStaff />} />
        <Route path="/schedule" element={<ScheduleMonth />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/quantri" element={<Admin />} />
      </Routes>
    </BrowserRouter>
  );
}
