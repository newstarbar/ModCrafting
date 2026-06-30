import React from 'react'

interface UpdateBannerProps {
  visible: boolean
  message: string
  percent: number
}

const UpdateBanner: React.FC<UpdateBannerProps> = ({ visible, message, percent }) => {
  if (!visible) return null

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-text">{message}</span>
      <div className="update-banner-track">
        <div className="update-banner-fill" style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      <span className="update-banner-percent">{percent}%</span>
    </div>
  )
}

export default UpdateBanner
