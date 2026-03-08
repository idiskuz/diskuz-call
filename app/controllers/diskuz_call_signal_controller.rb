# frozen_string_literal: true

class DiskuzCallSignalController < ApplicationController
  include DiskuzCallHelpers
  requires_login
  before_action :ensure_diskuz_call_enabled

  def send_signal
    target = User.find_by(id: params[:target_user_id])
    raise Discourse::InvalidParameters.new(:target_user_id) if target.blank?

    # Non puoi chiamare te stesso
    if target.id == current_user.id
      return render json: failed_json.merge(message: I18n.t("diskuz_call.cannot_call_yourself"), reason: "cannot_call_yourself"), status: 403
    end

    unless diskuz_call_user_enabled?(current_user)
      return render json: failed_json.merge(message: I18n.t("diskuz_call.not_allowed"), reason: "caller_not_in_allowed_groups"), status: 403
    end
    unless diskuz_call_user_enabled?(target)
      return render json: failed_json.merge(message: I18n.t("diskuz_call.not_allowed"), reason: "target_not_in_allowed_groups"), status: 403
    end
    if SiteSetting.diskuz_call_require_follow? && !target_follows_current_user?(target)
      return render json: failed_json.merge(message: I18n.t("diskuz_call.not_allowed"), reason: "follow_required"), status: 403
    end

    signal_type = params[:signal_type].to_s
    payload = signal_params

    # Incoming call: include caller avatar for theme UI
    if signal_type == "call_offer" && payload["avatar_template"].blank?
      payload["avatar_template"] = current_user.avatar_template
    end

    # Canale unico per tutti (come Resenha): tutti si sottoscrivono, user_ids filtra il destinatario
    message = {
      "from_user_id" => current_user.id,
      "from_username" => current_user.username,
      "signal_type" => signal_type,
      "payload" => payload,
    }
    MessageBus.publish(
      "/diskuz-call/signals",
      message,
      user_ids: [target.id],
    )

    # Discourse notification (bell) so the callee sees "Incoming call from @caller"
    if signal_type == "call_offer"
      create_incoming_call_notification(target, current_user)
    end

    render json: success_json
  end

  private

  def ensure_diskuz_call_enabled
    raise Discourse::NotFound unless SiteSetting.diskuz_call_enabled?
  end

  def signal_params
    raw = params.permit(payload: { sdp: {}, candidate: {}, avatar_template: {}, from_user_id: {} }).fetch(:payload, {})
    raw.respond_to?(:to_unsafe_h) ? raw.to_unsafe_h.stringify_keys : raw.to_h.stringify_keys
  rescue StandardError
    {}
  end

  def create_incoming_call_notification(callee, caller)
    # Messaggio con username così in campanella si vede "derac ti sta chiamando" / "derac is calling you"
    full_message = I18n.t("diskuz_call.calling_you", username: caller.username, default: "#{caller.username} is calling you")
    Notification.create!(
      notification_type: Notification.types[:chat_message],
      user_id: callee.id,
      topic_id: nil,
      data: {
        "message" => full_message,
        "title" => full_message,
        "excerpt" => full_message,
        "description" => full_message,
        "notification_message" => full_message,
        "i18n_key" => "diskuz_call.calling_you",
        "display_username" => caller.username,
        "username" => caller.username,
      }.to_json,
    )
  rescue StandardError => e
    Rails.logger.warn("diskuz-call: could not create notification: #{e.message}")
  end
end
