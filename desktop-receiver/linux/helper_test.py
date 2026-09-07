import importlib.util
import pathlib
from types import SimpleNamespace
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("helper.py")
SPEC = importlib.util.spec_from_file_location("poppy_linux_helper", MODULE_PATH)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


class HelperTests(unittest.TestCase):
    def test_parses_only_generic_bounded_requests(self):
        value = helper.parse_request(
            b'{"identifier":"poppy-0123456789abcdef0123456789abcdef","itemAlias":"alias_1","revision":2,"title":"Poppy needs your review.","body":"Poppy needs your review."}\n'
        )
        self.assertEqual(value["itemAlias"], "alias_1")
        with self.assertRaisesRegex(ValueError, "INVALID_REQUEST"):
            helper.parse_request(b'{"identifier":"bad","itemAlias":"alias_1","revision":2,"title":"Poppy needs your review.","body":"private"}\n')

    def test_builds_and_revalidates_only_the_poppy_protocol_target(self):
        uri = helper.poppy_uri("opaque_alias", 7)
        self.assertEqual(uri, "openmausbot://poppy?item=opaque_alias&revision=7")
        self.assertEqual(helper.validate_poppy_uri(uri), uri)
        for invalid in (
            "https://example.com",
            "openmausbot://poppy?item=opaque_alias&revision=0",
            "openmausbot://poppy?item=opaque_alias&revision=7&extra=x",
            "openmausbot://other?item=opaque_alias&revision=7",
        ):
            with self.assertRaisesRegex(ValueError, "INVALID_TARGET"):
                helper.validate_poppy_uri(invalid)

    def test_uses_stable_id_generic_text_and_an_application_action(self):
        calls = []
        flushed = []
        flush_succeeds = True

        class Connection:
            def flush_sync(self, cancellable):
                self_test.assertEqual(len(calls), len(flushed) + 1)
                flushed.append(cancellable)
                return flush_succeeds

        self_test = self

        class Variant:
            def __init__(self, _kind, value):
                self.value = value

        class VariantType:
            @staticmethod
            def new(kind):
                return kind

        class Action:
            def connect(self, *_args):
                pass

        class SimpleAction:
            @staticmethod
            def new(*_args):
                return Action()

        class Application:
            def __init__(self, application_id):
                self.application_id = application_id

            def add_action(self, _action):
                pass

            def register(self, _cancellable):
                return True

            def send_notification(self, identifier, notification):
                calls.append((identifier, notification))

            def get_dbus_connection(self):
                return Connection()

        class Notification:
            @staticmethod
            def new(title):
                return Notification(title)

            def __init__(self, title):
                self.title = title

            def set_body(self, body):
                self.body = body

            def set_default_action_and_target_value(self, action, target):
                self.action = action
                self.target = target

        Gio = SimpleNamespace(Application=Application, SimpleAction=SimpleAction, Notification=Notification)
        GLib = SimpleNamespace(Variant=Variant, VariantType=VariantType)

        request = helper.parse_request(
            b'{"identifier":"poppy-0123456789abcdef0123456789abcdef","itemAlias":"alias_1","revision":2,"title":"Poppy needs your review.","body":"Poppy needs your review."}\n'
        )
        helper.submit(request, Gio, GLib)
        self.assertEqual(flushed, [None])
        identifier, notification = calls[0]
        self.assertEqual(identifier, request["identifier"])
        self.assertEqual(notification.title, helper.GENERIC_TEXT)
        self.assertEqual(notification.body, helper.GENERIC_TEXT)
        self.assertEqual(notification.action, "app.open")
        self.assertEqual(notification.target.value, "openmausbot://poppy?item=alias_1&revision=2")
        flush_succeeds = False
        with self.assertRaisesRegex(RuntimeError, "NOTIFICATION_FLUSH_FAILED"):
            helper.submit(request, Gio, GLib)


if __name__ == "__main__":
    unittest.main()
