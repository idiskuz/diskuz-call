# frozen_string_literal: true

class DiskuzCallController < ApplicationController
  include DiskuzCallHelpers
  requires_login only: [:status, :preferences, :can_call]
  before_action :ensure_diskuz_call_enabled, except: [:watermark]
  skip_before_action :check_xhr, only: [:watermark]
  skip_before_action :redirect_to_login_if_required, only: [:watermark]

  def watermark
    path = File.join(File.expand_path("../..", __dir__), "public", "diskuz-watermark.png")
    return head(:not_found) unless File.file?(path)
    send_file path, type: "image/png", disposition: "inline"
  end

  def status
    ice_servers = parse_ice_servers_setting
    render json: {
      enabled: diskuz_call_user_enabled?(current_user),
      incoming_sound: SiteSetting.diskuz_call_incoming_sound.presence || "default",
      custom_ringtone_url: SiteSetting.diskuz_call_custom_ringtone_url.presence,
      ice_servers: ice_servers,
    }
  end

  def preferences
    enabled = ActiveModel::Type::Boolean.new.cast(params[:enabled])
    current_user.custom_fields["diskuz_call_enabled"] = enabled
    current_user.save_custom_fields(true)
    render json: success_json.merge(enabled: diskuz_call_user_enabled?(current_user))
  end

  def can_call
    target = User.find_by(id: params[:user_id])
    raise Discourse::InvalidParameters.new(:user_id) if target.blank?

    can = target.id != current_user.id &&
          diskuz_call_user_enabled?(current_user) &&
          diskuz_call_user_enabled?(target) &&
          target_follows_current_user?(target)
    render json: { can_call: can }
  end

  private

  def ensure_diskuz_call_enabled
    raise Discourse::NotFound unless SiteSetting.diskuz_call_enabled?
  end

  def parse_ice_servers_setting
    raw = SiteSetting.diskuz_call_ice_servers.presence
    return nil if raw.blank?
    JSON.parse(raw)
  rescue JSON::ParserError
    nil
  end
end
