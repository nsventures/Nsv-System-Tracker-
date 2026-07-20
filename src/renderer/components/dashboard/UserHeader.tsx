import React, { useRef, useEffect } from 'react';
import { whiteLabelConfig } from '../../../whiteLabel.config';
import { User } from '../../types';
import logo from '../../../../assets/nsv-logo-new.webp';
import logoBlack from '../../../../assets/nsv-black.png';

interface UserHeaderProps {
  user: User;
  theme: string;
  isDropdownOpen: boolean;
  toggleDropdown: () => void;
  toggleTheme: () => void;
  logout: () => void;
}

function UserHeader({
  user,
  theme,
  isDropdownOpen,
  toggleDropdown,
  toggleTheme,
  logout,
}: UserHeaderProps): React.ReactElement {
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Handle clicks outside the dropdown to close it
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        if (isDropdownOpen) {
          toggleDropdown();
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isDropdownOpen, toggleDropdown]);

  // Get user initials for avatar
  const getUserInitials = (): string => {
    if (!user || !user.user_name) return '';

    const nameParts = user.user_name.split(' ');
    if (nameParts.length >= 2) {
      return `${nameParts[0][0]}${nameParts[1][0]}`.toUpperCase();
    }
    return nameParts[0][0].toUpperCase();
  };

  return (
    <header className="dashboard-header">
      <img
        src={theme === 'light' ? logoBlack : logo}
        alt={whiteLabelConfig.ui.dashboardTitle}
        className="dashboard-logo"
        style={{ height: '40px', width: 'auto' }}
      />
      <div className="user-info">
        <div
          className="avatar"
          onClick={toggleDropdown}
          role="button"
          tabIndex={0}
          aria-haspopup="true"
          aria-expanded={isDropdownOpen}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              toggleDropdown();
            }
          }}
        >
          {getUserInitials()}
        </div>
        <div
          ref={dropdownRef}
          className={`dropdown-menu ${isDropdownOpen ? 'open' : ''}`}
        >
          <div className="user-name">{user.user_name}</div>
          <div
            className="dropdown-item theme-toggle"
            onClick={toggleTheme}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                toggleTheme();
              }
            }}
          >
            {theme === 'light' ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
          </div>
          <div
            className="dropdown-item logout"
            onClick={logout}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                logout();
              }
            }}
          >
            Logout
          </div>
        </div>
      </div>
    </header>
  );
}

export default UserHeader;
