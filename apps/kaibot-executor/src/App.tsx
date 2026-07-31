import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import Dashboard from './pages/Dashboard';
import Terminal from './pages/Terminal';
import Positions from './pages/Positions';
import Portfolio from './pages/Portfolio';
import Exchanges from './pages/Exchanges';
import ExchangeDetailPage from './pages/ExchangeDetailPage';
import Setup from './pages/Setup';
import Login from './pages/Login';
import Subscriptions from './pages/Subscriptions';
import Activity from './pages/Activity';
import Settings from './pages/Settings';
import SyntheticUsd from './pages/SyntheticUsd';
import Markets from './pages/Markets';
import Analytics from './pages/Analytics';
import Reconciliation from './pages/Reconciliation';
import ExecutionDetail from './pages/ExecutionDetail';
import { AuthCheck } from './components/AuthCheck';
import { NotificationProvider } from './components/NotificationProvider';

function App() {
  return (
    <Router>
      <NotificationProvider>
        <AuthCheck>
          <Routes>
            <Route path="/setup" element={<Setup />} />
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<AppLayout />}>
              <Route index element={<Dashboard />} />
              <Route path="terminal" element={<Terminal />} />
              <Route path="positions" element={<Positions />} />
              <Route path="portfolio" element={<Portfolio />} />
              <Route path="synthetic-usd" element={<SyntheticUsd />} />
              <Route path="exchanges" element={<Exchanges />} />
              <Route path="exchanges/:exchangeName" element={<ExchangeDetailPage />} />
              <Route path="markets" element={<Markets />} />
              <Route path="subscriptions" element={<Subscriptions />} />
              <Route path="analytics" element={<Analytics />} />
              <Route path="activity" element={<Activity />} />
              <Route path="activity/:signalId" element={<ExecutionDetail />} />
              <Route path="reconciliation" element={<Reconciliation />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Routes>
        </AuthCheck>
      </NotificationProvider>
    </Router>
  );
}

export default App;