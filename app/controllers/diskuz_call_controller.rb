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
    custom_ringtones = build_custom_ringtones_list
    selected_index = current_user.custom_fields["diskuz_call_selected_custom_ringtone_index"]
    selected_index = selected_index.to_i if selected_index.is_a?(String)
    selected_index = nil if selected_index.nil? || selected_index < 0 || selected_index > 9
    selected_entry = selected_index && custom_ringtones.find { |r| r[:index] == selected_index }
    selected_url = selected_entry ? selected_entry[:url] : (custom_ringtones.first&.dig(:url))
    primary = SiteSetting.diskuz_call_primary_color.presence || "#13c98c"
    primary = "#13c98c" unless primary.match?(/\A#[0-9a-fA-F]{6}\z/)
    primary_dark = diskuz_call_darken_hex(primary)
    render json: {
      enabled: diskuz_call_user_enabled?(current_user),
      video_allowed: diskuz_call_video_allowed?(current_user),
      incoming_sound: SiteSetting.diskuz_call_incoming_sound.presence || "default",
      custom_ringtones: custom_ringtones,
      custom_ringtone_url: selected_url,
      selected_custom_ringtone_index: selected_index,
      alternative_ringtone: SiteSetting.diskuz_call_alternative_ringtone.presence || "soft",
      ice_servers: ice_servers,
      primary_color: primary,
      primary_color_dark: primary_dark,
    }
  end

  def preferences
    if params.key?(:enabled)
      enabled = ActiveModel::Type::Boolean.new.cast(params[:enabled])
      current_user.custom_fields["diskuz_call_enabled"] = enabled
    end
    if params.key?(:selected_custom_ringtone_index)
      idx = params[:selected_custom_ringtone_index].to_i
      current_user.custom_fields["diskuz_call_selected_custom_ringtone_index"] = (idx >= 0 && idx <= 9) ? idx : nil
    end
    current_user.save_custom_fields(true)
    custom_ringtones = build_custom_ringtones_list
    selected_index = current_user.custom_fields["diskuz_call_selected_custom_ringtone_index"]&.to_i
    selected_entry = selected_index && custom_ringtones.find { |r| r[:index] == selected_index }
    selected_url = selected_entry ? selected_entry[:url] : (custom_ringtones.first&.dig(:url))
    render json: success_json.merge(
      enabled: diskuz_call_user_enabled?(current_user),
      custom_ringtone_url: selected_url,
      selected_custom_ringtone_index: selected_index,
    )
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

  def diskuz_call_darken_hex(hex)
    hex = hex.to_s.strip.sub(/\A#/, "")
    return "#0f8f6a" if hex.length != 6
    r, g, b = hex[0..1].to_i(16), hex[2..3].to_i(16), hex[4..5].to_i(16)
    r = (r * 0.72).round.clamp(0, 255)
    g = (g * 0.72).round.clamp(0, 255)
    b = (b * 0.72).round.clamp(0, 255)
    format("#%02x%02x%02x", r, g, b)
  end

  def parse_ice_servers_setting
    raw = SiteSetting.diskuz_call_ice_servers.presence
    return nil if raw.blank?
    JSON.parse(raw)
  rescue JSON::ParserError
    nil
  end

  def build_custom_ringtones_list
    list = []
    (1..10).each do |i|
      url = SiteSetting.public_send(:"diskuz_call_custom_ringtone_#{i}").to_s.strip
      next if url.blank?
      list << { index: i - 1, label: I18n.t("diskuz_call.custom_ringtone_n", n: i), url: url }
    end
    list
  end
end
