/* global Office */

Office.onReady(() => {});

function action(event) {
  const message = {
    type: Office.MailboxEnums.ItemNotificationMessageType.InformationalMessage,
    message: 'Action performed.',
    icon: 'Icon.80x80',
    persistent: true
  };

  Office.context.mailbox.item?.notificationMessages.replaceAsync(
    'ActionPerformanceNotification',
    message
  );

  event.completed();
}

Office.actions.associate('action', action);
