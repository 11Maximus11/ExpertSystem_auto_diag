# R8 rules for app-local code (yours — `lecodes app sync` never touches this file).
#
# The LeCodes SDK keeps its own JNI-bound classes through the consumer rules inside the AAR, and
# plugin modules bring their own. Add rules here only for classes YOUR Kotlin registers with the
# engine by name (engine.registerCallback / registerService / registerView) or reaches through
# reflection, e.g.
#   -keep class com.example.myapp.MyBridge { *; }
