import React, { useState } from 'react';

export interface ReasonModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}

function ReasonModal({
  isOpen,
  onClose,
  onSubmit,
}: ReasonModalProps): React.ReactElement | null {
  const [reason, setReason] = useState('');

  if (!isOpen) return null;

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (reason.trim()) {
      onSubmit(reason);
      setReason('');
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h2>Enter Reason for Manual Time</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="reason-input">
              Reason:
              <textarea
                id="reason-input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Enter reason for manual time"
                required
              />
            </label>
          </div>
          <div className="modal-actions">
            <button type="button" onClick={onClose} className="cancel-button">
              Cancel
            </button>
            <button type="submit" className="submit-button">
              Submit
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default ReasonModal;
